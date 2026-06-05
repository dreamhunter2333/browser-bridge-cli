const DEFAULT_WS_URL = 'ws://127.0.0.1:52853/ext';
const KEEPALIVE_ALARM = 'keepalive';
const RECONNECT_ALARM = 'reconnect';
const IDLE_ALARM = 'idle-check';
const IDLE_TIMEOUT = 24 * 60 * 60 * 1000; // 24h default
const DEFAULT_MAX_FAILURES = 10;

const networkLog = [];
const MAX_NETWORK_LOG = 500;
const pendingBodies = new Map();

// --- State ---

let enabled = false;
let whitelistEnabled = false;
let whitelist = [];
let pairingToken = null;
let clientName = null;
let wsUrl = DEFAULT_WS_URL;
let lastActivity = Date.now();
let consecutiveFailures = 0;
let maxFailures = DEFAULT_MAX_FAILURES;
let idleTimeout = IDLE_TIMEOUT;
let stateLoaded = false;

const stateReady = new Promise((resolve) => {
  chrome.storage.local.get(['enabled', 'whitelistEnabled', 'whitelist', 'pairingToken', 'clientName', 'wsUrl', 'idleTimeout', 'maxFailures'], (state) => {
    enabled = state.enabled === true;
    whitelistEnabled = state.whitelistEnabled === true;
    whitelist = state.whitelist || [];
    pairingToken = state.pairingToken || null;
    clientName = state.clientName || null;
    wsUrl = state.wsUrl || DEFAULT_WS_URL;
    idleTimeout = state.idleTimeout || IDLE_TIMEOUT;
    maxFailures = state.maxFailures || DEFAULT_MAX_FAILURES;
    stateLoaded = true;
    resolve();
    if (enabled) connect();
  });
});

// --- Whitelist ---

const TAB_ACTIONS = new Set([
  'eval', 'eval.file', 'query', 'cdp', 'cdp.detach',
  'screenshot', 'screenshot.full', 'pdf',
  'navigate', 'reload', 'tabs.activate', 'tabs.close',
]);

function matchPattern(pattern, url) {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return regex.test(url);
}

async function checkWhitelist(action, params) {
  if (!whitelistEnabled || !TAB_ACTIONS.has(action)) return;
  if (whitelist.length === 0) {
    throw new Error('Whitelist is enabled but empty — all sites blocked. Add patterns or disable whitelist.');
  }
  const tid = await getTargetTabId(params.tabId);
  const tab = await chrome.tabs.get(tid);
  const url = tab.url || '';
  const allowed = whitelist.some(p => matchPattern(p, url));
  if (!allowed) {
    throw new Error(`Blocked by whitelist: ${url}`);
  }
}

// --- Network logging ---

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.requestBody) {
      pendingBodies.set(details.requestId, details.requestBody);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const entry = {
      requestId: details.requestId,
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      type: details.type,
      timeStamp: details.timeStamp,
      tabId: details.tabId,
      fromCache: details.fromCache,
      ip: details.ip,
    };
    const body = pendingBodies.get(details.requestId);
    if (body) {
      entry.requestBody = body;
      pendingBodies.delete(details.requestId);
    }
    networkLog.push(entry);
    if (networkLog.length > MAX_NETWORK_LOG) networkLog.shift();
  },
  { urls: ['<all_urls>'] }
);

// Fix: clean up pendingBodies on request error/abort
chrome.webRequest.onErrorOccurred.addListener(
  (details) => { pendingBodies.delete(details.requestId); },
  { urls: ['<all_urls>'] }
);

// --- WebSocket connection (with chrome.alarms for SW keepalive) ---

let ws = null;

function connect() {
  if (!enabled) return;
  if (ws && ws.readyState <= 1) return;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to bridge server');
    // Keepalive alarm: prevent SW from sleeping while connected
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
    chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 60 });
    chrome.alarms.clear(RECONNECT_ALARM);
    // Send auth token if we have one
    const name = clientName || (navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome');
    ws.send(JSON.stringify({ type: 'auth', token: pairingToken || '', name }));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    // Auth/pairing responses from bridge
    if (msg.type === 'auth') {
      if (msg.success) {
        console.log('Authenticated');
      } else if (msg.needsPairing) {
        console.log('Pairing required');
      }
      return;
    }
    if (msg.type === 'pair') {
      // Handled by onMessage pair handler
      return;
    }

    const { id, action, params } = msg;
    lastActivity = Date.now();
    let response;
    try {
      await stateReady;
      const result = await handleAction(action, params || {});
      response = { id, success: true, data: result };
      consecutiveFailures = 0;
    } catch (err) {
      response = { id, success: false, error: String(err) };
      consecutiveFailures++;
      if (consecutiveFailures >= maxFailures) {
        console.log(`${consecutiveFailures} consecutive failures, auto-disabling`);
        chrome.storage.local.set({ enabled: false });
        setTimeout(() => disconnect(), 100);
      }
    }
    // Fix: guard ws.send against closed connection
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(response));
      }
    } catch {}
  };

  ws.onclose = () => {
    console.log('Disconnected');
    ws = null;
    chrome.alarms.clear(KEEPALIVE_ALARM);
    if (enabled) {
      // Fix: use chrome.alarms instead of setTimeout for reconnect
      chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.05 });
    }
  };

  ws.onerror = () => {
    console.log('WebSocket error');
  };
}

function disconnect() {
  enabled = false;
  chrome.alarms.clear(KEEPALIVE_ALARM);
  chrome.alarms.clear(RECONNECT_ALARM);
  chrome.alarms.clear(IDLE_ALARM);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

// Alarm handler for keepalive + reconnect
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && enabled) {
    connect();
  }
  if (alarm.name === IDLE_ALARM) {
    if (enabled && Date.now() - lastActivity > idleTimeout) {
      console.log('Idle timeout reached, auto-disabling');
      chrome.storage.local.set({ enabled: false });
      disconnect();
    }
  }
});

// --- Message from popup ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'enable':
      enabled = true;
      connect();
      sendResponse({ ok: true });
      break;
    case 'disable':
      disconnect();
      sendResponse({ ok: true });
      break;
    case 'getStatus':
      sendResponse({ connected: ws && ws.readyState === 1, enabled, paired: !!pairingToken });
      break;
    case 'pair': {
      const targetUrl = msg.wsUrl || wsUrl;
      const doPair = async () => {
        if (targetUrl !== wsUrl || !ws || ws.readyState !== 1) {
          wsUrl = targetUrl;
          chrome.storage.local.set({ wsUrl });
          if (ws) { ws.onclose = null; ws.close(); ws = null; }
          enabled = true;
          chrome.storage.local.set({ enabled: true });
          try {
            await new Promise((resolve, reject) => {
              connect();
              const checkInterval = setInterval(() => {
                if (ws && ws.readyState === 1) { clearInterval(checkInterval); resolve(undefined); }
              }, 200);
              setTimeout(() => { clearInterval(checkInterval); reject(new Error('timeout')); }, 5000);
            });
          } catch {
            sendResponse({ success: false, error: `Cannot connect to ${targetUrl}` });
            return;
          }
        }
        if (!ws || ws.readyState !== 1) {
          sendResponse({ success: false, error: 'Not connected' });
          return;
        }
        const pairHandler = (event) => {
          const resp = JSON.parse(event.data);
          if (resp.type === 'pair') {
            ws.removeEventListener('message', pairHandler);
            if (resp.success && resp.token) {
              pairingToken = resp.token;
              clientName = msg.name || null;
              chrome.storage.local.set({ pairingToken, clientName, wsUrl });
            }
            sendResponse(resp);
          }
        };
        ws.addEventListener('message', pairHandler);
        ws.send(JSON.stringify({ type: 'pair', code: msg.code, name: msg.name }));
      };
      doPair();
      break;
    }
    case 'unpair':
      pairingToken = null;
      clientName = null;
      wsUrl = DEFAULT_WS_URL;
      chrome.storage.local.set({ enabled: false });
      chrome.storage.local.remove(['pairingToken', 'clientName', 'wsUrl']);
      disconnect();
      sendResponse({ ok: true });
      break;
    case 'whitelistUpdated':
      chrome.storage.local.get(['whitelistEnabled', 'whitelist'], (state) => {
        whitelistEnabled = state.whitelistEnabled === true;
        whitelist = state.whitelist || [];
      });
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// --- CDP (chrome.debugger) ---

const attached = new Set();

function isDebuggableUrl(url) {
  if (!url) return true;
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank';
}

async function ensureAttached(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isDebuggableUrl(tab.url)) {
    attached.delete(tabId);
    throw new Error(`Cannot debug tab: URL is ${tab.url}`);
  }

  if (attached.has(tabId)) {
    try {
      await cdpSend(tabId, 'Runtime.evaluate', { expression: '1', returnByValue: true });
      return;
    } catch {
      attached.delete(tabId);
    }
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500;
  let lastError = '';

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, '1.3', () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      lastError = '';
      break;
    } catch (e) {
      lastError = String(e);
      if (i < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }
    }
  }

  if (lastError) throw new Error(`attach failed: ${lastError}`);
  attached.add(tabId);

  try {
    await cdpSend(tabId, 'Runtime.enable');
  } catch {}
}

function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

async function cdpEval(tabId, expression) {
  const MAX_RETRIES = 2;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      await ensureAttached(tabId);
      const result = await cdpSend(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const err = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Eval error';
        throw new Error(err);
      }
      return result.result?.value;
    } catch (e) {
      const msg = String(e);
      const isRetryable = msg.includes('Inspected target navigated')
        || msg.includes('Target closed')
        || msg.includes('attach failed')
        || msg.includes('Debugger is not attached');
      if (isRetryable && i < MAX_RETRIES) {
        attached.delete(tabId);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
}

async function cdpDetach(tabId) {
  attached.delete(tabId);
  try {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => resolve());
    });
  } catch {}
}

// --- Tab helpers ---

async function getTargetTabId(tabId) {
  if (tabId != null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

// --- Action handler ---

async function handleAction(action, params) {
  await checkWhitelist(action, params);

  switch (action) {
    case 'ping':
      return { status: 'ok', version: chrome.runtime.getManifest().version, enabled, whitelistEnabled };

    case 'eval': {
      const tid = await getTargetTabId(params.tabId);
      try {
        return await cdpEval(tid, params.expression);
      } finally {
        if (params.keepAttached !== true) await cdpDetach(tid);
      }
    }

    case 'eval.file': {
      const tid = await getTargetTabId(params.tabId);
      try {
        return await cdpEval(tid, params.code);
      } finally {
        if (params.keepAttached !== true) await cdpDetach(tid);
      }
    }

    case 'query': {
      const tid = await getTargetTabId(params.tabId);
      // Fix: sanitize limit with parseInt
      const limit = parseInt(params.limit, 10) || 50;
      const expr = `JSON.parse(JSON.stringify((() => {
        const els = document.querySelectorAll(${JSON.stringify(params.selector)});
        const out = [];
        const limit = ${limit};
        for (let i = 0; i < Math.min(els.length, limit); i++) {
          const el = els[i];
          out.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className: el.className || undefined,
            text: el.textContent?.slice(0, 200),
            href: el.href || undefined,
            src: el.src || undefined,
            rect: el.getBoundingClientRect().toJSON(),
          });
        }
        return out;
      })()))`;
      try {
        return await cdpEval(tid, expr);
      } finally {
        if (params.keepAttached !== true) await cdpDetach(tid);
      }
    }

    case 'tabs.list': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        groupId: t.groupId,
        index: t.index,
        status: t.status,
      }));
    }

    case 'tabs.get':
      return await chrome.tabs.get(params.tabId);

    case 'tabs.create': {
      const tab = await chrome.tabs.create({
        url: params.url || 'about:blank',
        active: false,
      });
      await chrome.tabs.update(tab.id, { active: true });
      return { id: tab.id, url: tab.url, title: tab.title };
    }

    case 'tabs.close':
      await chrome.tabs.remove(params.tabId);
      return { ok: true };

    case 'tabs.activate': {
      await chrome.tabs.update(params.tabId, { active: true });
      return { ok: true };
    }

    case 'navigate': {
      const tid = await getTargetTabId(params.tabId);
      await chrome.tabs.update(tid, { url: params.url });
      return { ok: true };
    }

    case 'reload': {
      const tid = await getTargetTabId(params.tabId);
      await chrome.tabs.reload(tid, { bypassCache: !!params.bypassCache });
      return { ok: true };
    }

    case 'screenshot': {
      const tid = await getTargetTabId(params.tabId);
      await ensureAttached(tid);
      try {
        const { data } = await cdpSend(tid, 'Page.captureScreenshot', {
          format: params.format || 'png',
          quality: params.quality || 90,
        });
        return { dataUrl: `data:image/${params.format || 'png'};base64,${data}` };
      } finally {
        if (params.keepAttached !== true) await cdpDetach(tid);
      }
    }

    case 'screenshot.full': {
      const tid = await getTargetTabId(params.tabId);
      await ensureAttached(tid);
      try {
        const metrics = await cdpSend(tid, 'Page.getLayoutMetrics');
        const { width, height } = metrics.contentSize;
        await cdpSend(tid, 'Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(width),
          height: Math.ceil(height),
          deviceScaleFactor: 1,
          mobile: false,
        });
        const { data } = await cdpSend(tid, 'Page.captureScreenshot', {
          format: params.format || 'png',
        });
        return { dataUrl: `data:image/${params.format || 'png'};base64,${data}` };
      } finally {
        await cdpSend(tid, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
        await cdpDetach(tid);
      }
    }

    case 'pdf': {
      const tid = await getTargetTabId(params.tabId);
      await ensureAttached(tid);
      try {
        const { data } = await cdpSend(tid, 'Page.printToPDF', {
          printBackground: true,
          ...(params.options || {}),
        });
        return { dataBase64: data };
      } finally {
        await cdpDetach(tid);
      }
    }

    case 'network.getAll':
      return networkLog.slice(-(params.limit || 100));

    case 'network.clear':
      networkLog.length = 0;
      return { ok: true };

    case 'cookies.get':
      return await chrome.cookies.getAll(params.filter || {});

    case 'cdp': {
      const tid = await getTargetTabId(params.tabId);
      await ensureAttached(tid);
      try {
        return await cdpSend(tid, params.method, params.params);
      } finally {
        if (params.keepAttached !== true) await cdpDetach(tid);
      }
    }

    case 'cdp.detach': {
      const tid = await getTargetTabId(params.tabId);
      await cdpDetach(tid);
      return { ok: true };
    }

    // Remote disable (enable only from popup)
    case 'disable':
      chrome.storage.local.set({ enabled: false });
      setTimeout(() => disconnect(), 100);
      return { ok: true };

    case 'whitelist.get':
      return { whitelistEnabled, whitelist };

    // Fix: whitelist.set only from popup (not remote)
    case 'whitelist.set':
      return { ok: false, error: 'Whitelist can only be modified from popup' };

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
