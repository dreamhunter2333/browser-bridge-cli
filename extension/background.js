const DEFAULT_WS_URL = 'ws://127.0.0.1:52853/ext';
const KEEPALIVE_ALARM = 'keepalive';
const RECONNECT_ALARM = 'reconnect';
const IDLE_ALARM = 'idle-check';
const IDLE_TIMEOUT = 24 * 60 * 60 * 1000; // 24h default
const DEFAULT_MAX_FAILURES = 10;

const MAX_NETWORK_LOG = 500;
const networkLogs = new Map();
const networkRequests = new Map();

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
  'eval', 'eval.file', 'query', 'cdp', 'cdp.detach', 'cdp.events', 'cdp.retain', 'cdp.frames',
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
        const video = response.data?.frame?.video;
        if (video) {
          const data = Uint8Array.from(atob(video.data), c => c.charCodeAt(0));
          const header = new TextEncoder().encode(JSON.stringify({ ...response, data: { frame: { ...response.data.frame, video: { ...video, data: undefined } } } }));
          const packet = new Uint8Array(4 + header.length + data.length);
          new DataView(packet.buffer).setUint32(0, header.length);
          packet.set(header, 4); packet.set(data, 4 + header.length);
          ws.send(packet);
        } else ws.send(JSON.stringify(response));
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
  for (const tabId of debuggerLeases.keys()) void releaseDebuggerLease(tabId);
  cdpEventStreams.clear();
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
  if (msg.target === 'video') return;
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
const attaching = new Map();
const debuggerLeases = new Map();
const debuggerUsers = new Map();
const pendingDetach = new Set();
const debuggerIdleTimers = new Map();
const DEBUGGER_IDLE_TIMEOUT = 5 * 60 * 1000;

function clearDebuggerIdle(tabId) {
  clearTimeout(debuggerIdleTimers.get(tabId));
  debuggerIdleTimers.delete(tabId);
}

function scheduleDebuggerIdle(tabId) {
  clearDebuggerIdle(tabId);
  if (!attached.has(tabId) || debuggerLeases.has(tabId) || debuggerUsers.get(tabId)) return;
  debuggerIdleTimers.set(tabId, setTimeout(() => { void cdpDetach(tabId); }, DEBUGGER_IDLE_TIMEOUT));
}
const DEBUGGER_ACTIONS = new Set([
  'eval', 'eval.file', 'query', 'cdp', 'cdp.detach', 'cdp.events', 'cdp.retain', 'cdp.release', 'cdp.frames',
  'screenshot', 'screenshot.full', 'pdf', 'cookies.get', 'network.getAll',
  'navigate', 'reload', 'tabs.activate', 'tabs.get', 'tabs.close',
]);
const cdpEventStreams = new Map();
const MAX_CDP_EVENTS = 500;
const MAX_CDP_EVENT_BYTES = 2 * 1024 * 1024;

function newCdpEventStream() {
  return { id: crypto.randomUUID(), cursor: 0, droppedThrough: 0, bytes: 0, events: [], detached: null };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const lease = debuggerLeases.get(tabId);
  if (lease) clearTimeout(lease.timer);
  debuggerLeases.delete(tabId);
  if (lease?.capture) void videoMessage({ operation: 'close', id: lease.id }).catch(() => {});
  pendingDetach.delete(tabId);
  clearDebuggerIdle(tabId);
  attached.delete(tabId);
  cdpEventStreams.delete(tabId);
  networkLogs.delete(tabId);
  networkRequests.delete(tabId);
});

function getNetworkLog(tabId) {
  if (!networkLogs.has(tabId)) networkLogs.set(tabId, []);
  return networkLogs.get(tabId);
}

function getNetworkRequests(tabId) {
  if (!networkRequests.has(tabId)) networkRequests.set(tabId, new Map());
  return networkRequests.get(tabId);
}

function appendNetworkEntry(tabId, entry) {
  const log = getNetworkLog(tabId);
  log.push(entry);
  if (log.length > MAX_NETWORK_LOG) log.shift();
  getNetworkRequests(tabId).set(entry.requestId, entry);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !attached.has(tabId)) return;

  const lease = debuggerLeases.get(tabId);
  if (!source.sessionId && method === 'Page.screencastFrame' && lease?.capture) {
    lease.frame = { sequence: ++lease.sequence, data: params.data, metadata: params.metadata };
    void cdpSend(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    return;
  }

  const stream = cdpEventStreams.get(tabId);
  if (stream) {
    const event = { sequence: ++stream.cursor, method, params, ...(source.sessionId ? { sessionId: source.sessionId } : {}) };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    stream.events.push({ event, bytes });
    stream.bytes += bytes;
    while (stream.events.length > MAX_CDP_EVENTS || stream.bytes > MAX_CDP_EVENT_BYTES) {
      const removed = stream.events.shift();
      stream.bytes -= removed.bytes;
      stream.droppedThrough = removed.event.sequence;
    }
  }

  if (source.sessionId) return;

  if (method === 'Network.requestWillBeSent') {
    appendNetworkEntry(tabId, {
      requestId: params.requestId,
      loaderId: params.loaderId,
      url: params.request?.url,
      method: params.request?.method,
      type: params.type,
      timeStamp: params.timestamp,
      wallTime: params.wallTime,
      tabId,
      requestHeaders: params.request?.headers,
      postData: params.request?.postData,
      initiator: params.initiator,
      redirectResponse: params.redirectResponse,
    });
    return;
  }

  const entry = getNetworkRequests(tabId).get(params.requestId);
  if (!entry) return;

  if (method === 'Network.responseReceived') {
    entry.statusCode = params.response?.status;
    entry.statusText = params.response?.statusText;
    entry.mimeType = params.response?.mimeType;
    entry.responseHeaders = params.response?.headers;
    entry.fromCache = !!(params.response?.fromDiskCache || params.response?.fromPrefetchCache);
    entry.ip = params.response?.remoteIPAddress;
    entry.protocol = params.response?.protocol;
    return;
  }

  if (method === 'Network.loadingFinished') {
    entry.encodedDataLength = params.encodedDataLength;
    entry.finished = true;
    return;
  }

  if (method === 'Network.loadingFailed') {
    entry.errorText = params.errorText;
    entry.canceled = params.canceled;
    entry.finished = true;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  clearDebuggerIdle(source.tabId);
  attached.delete(source.tabId);
  const stream = cdpEventStreams.get(source.tabId);
  if (stream) stream.detached = reason;
});

function isDebuggableUrl(url) {
  if (!url) return true;
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank';
}

async function ensureAttached(tabId) {
  if (attaching.has(tabId)) return attaching.get(tabId);
  const work = attachDebugger(tabId);
  attaching.set(tabId, work);
  try { await work; } finally { attaching.delete(tabId); }
}

async function attachDebugger(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isDebuggableUrl(tab.url)) {
    attached.delete(tabId);
    throw new Error(`Cannot debug tab: URL is ${tab.url}`);
  }

  if (attached.has(tabId)) return;

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
  if (cdpEventStreams.get(tabId)?.detached) cdpEventStreams.set(tabId, newCdpEventStream());

  try {
    await cdpSend(tabId, 'Runtime.enable');
  } catch {}
  try {
    await cdpSend(tabId, 'Network.enable');
  } catch {}
}

function cdpSend(tabId, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params || {}, (result) => {
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
  pendingDetach.add(tabId);
  if (debuggerLeases.has(tabId) || debuggerUsers.get(tabId)) return;
  pendingDetach.delete(tabId);
  clearDebuggerIdle(tabId);
  attached.delete(tabId);
  const stream = cdpEventStreams.get(tabId);
  if (stream) stream.detached = 'explicit_detach';
  try {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => resolve());
    });
  } catch {}
}

function refreshDebuggerLease(tabId, leaseId) {
  const lease = debuggerLeases.get(tabId);
  if (!lease || lease.releasing || lease.id !== leaseId) throw new Error('Debugger lease expired or changed');
  clearTimeout(lease.timer);
  lease.timer = setTimeout(() => { void releaseDebuggerLease(tabId); }, 45000);
  return lease;
}

async function videoMessage(message) {
  let timer;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage({ target: 'video', ...message }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('WebCodecs encoder timed out')), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

let creatingVideo;
async function ensureVideo() {
  if (!chrome.offscreen) throw new Error('WebCodecs requires the offscreen extension API');
  if (!creatingVideo) creatingVideo = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('video.html')] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'video.html', reasons: ['BLOBS'], justification: 'Encode tab image blobs with WebCodecs for low-bandwidth sharing' });
  })().finally(() => { creatingVideo = null; });
  await creatingVideo;
  if (!(await videoMessage({ operation: 'probe' }))?.supported) throw new Error('WebCodecs VP8 encoder is unavailable');
}

async function releaseDebuggerLease(tabId) {
  const lease = debuggerLeases.get(tabId);
  if (!lease) return;
  if (lease.releasing) return lease.releasing;
  clearTimeout(lease.timer);
  lease.releasing = (async () => {
    if (lease.capture) await Promise.allSettled([
      videoMessage({ operation: 'close', id: lease.id }),
      cdpSend(tabId, 'Page.stopScreencast'),
    ]);
    debuggerLeases.delete(tabId);
  })();
  await lease.releasing;
  if (lease.detachOnRelease || pendingDetach.has(tabId)) await cdpDetach(tabId);
  else scheduleDebuggerIdle(tabId);
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
  if (!DEBUGGER_ACTIONS.has(action)) return dispatchAction(action, params);
  const tabId = await getTargetTabId(params.tabId);
  clearDebuggerIdle(tabId);
  debuggerUsers.set(tabId, (debuggerUsers.get(tabId) || 0) + 1);
  try {
    return await dispatchAction(action, { ...params, tabId });
  } finally {
    const remaining = debuggerUsers.get(tabId) - 1;
    if (remaining) debuggerUsers.set(tabId, remaining);
    else debuggerUsers.delete(tabId);
    if (!remaining && pendingDetach.has(tabId)) await cdpDetach(tabId);
    if (!remaining) scheduleDebuggerIdle(tabId);
  }
}

async function dispatchAction(action, params) {
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

    case 'tabs.current':
      return await chrome.tabs.get(await getTargetTabId());

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

    case 'network.getAll': {
      const tid = await getTargetTabId(params.tabId);
      await ensureAttached(tid);
      return getNetworkLog(tid).slice(-(params.limit || 100));
    }

    case 'network.clear':
      if (params.tabId != null) {
        networkLogs.set(params.tabId, []);
        networkRequests.set(params.tabId, new Map());
      } else {
        networkLogs.clear();
        networkRequests.clear();
      }
      return { ok: true };

    case 'cookies.get': {
      const tid = await getTargetTabId(params.tabId);
      const tab = await chrome.tabs.get(tid);
      const filter = params.filter || {};
      const urls = filter.url ? [filter.url] : (tab.url ? [tab.url] : undefined);
      await ensureAttached(tid);
      try {
        const result = await cdpSend(tid, 'Network.getCookies', urls ? { urls } : {});
        let cookies = result.cookies || [];
        if (filter.domain) cookies = cookies.filter(cookie => cookie.domain === filter.domain || cookie.domain.endsWith(`.${filter.domain}`));
        if (filter.name) cookies = cookies.filter(cookie => cookie.name === filter.name);
        return cookies;
      } finally {
        await cdpDetach(tid);
      }
    }

    case 'cdp.retain': {
      const tid = params.tabId;
      if (debuggerLeases.has(tid)) throw new Error('This tab is already being shared');
      const lease = { id: crypto.randomUUID(), detachOnRelease: !attached.has(tid), timer: null };
      debuggerLeases.set(tid, lease);
      refreshDebuggerLease(tid, lease.id);
      try {
        await ensureAttached(tid);
        return { tabId: tid, leaseId: lease.id };
      } catch (error) {
        await releaseDebuggerLease(tid);
        throw error;
      }
    }

    case 'cdp.release': {
      const lease = debuggerLeases.get(params.tabId);
      if (!lease) return { ok: true };
      if (lease.id !== params.leaseId) throw new Error('Debugger lease changed');
      await releaseDebuggerLease(params.tabId);
      return { ok: true };
    }

    case 'cdp.frames': {
      const tid = params.tabId;
      const lease = refreshDebuggerLease(tid, params.leaseId);
      if (params.stop) {
        await videoMessage({ operation: 'close', id: lease.id });
        return { stopped: true };
      }
      if (params.start) {
        if (!lease.capture) {
          await ensureAttached(tid);
          await cdpSend(tid, 'Page.enable');
          await ensureVideo();
          lease.capture = true;
          lease.sequence = 0;
          await cdpSend(tid, 'Page.startScreencast', { format: 'png', maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
          if (!lease.frame) {
            const { cssVisualViewport } = await cdpSend(tid, 'Page.getLayoutMetrics');
            const { data } = await cdpSend(tid, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            if (!lease.frame) lease.frame = { sequence: ++lease.sequence, data, metadata: { deviceWidth: cssVisualViewport.clientWidth } };
          }
        }
      }
      if (!attached.has(tid)) throw new Error('Shared tab debugger disconnected');
      if (params.start) return { video: true };
      if (params.idle) return { frame: null };
      const frame = lease.frame;
      if (!frame || (frame.sequence === params.since && !params.keyFrame)) return { frame: null };
      try {
        const video = await videoMessage({ operation: 'encode', id: lease.id, data: frame.data, keyFrame: !!params.keyFrame });
        if (!video || video.error) throw new Error(video?.error || 'Encoder unavailable');
        if (video.unchanged) return { frame: null };
        return { frame: { sequence: frame.sequence, metadata: frame.metadata, video } };
      } catch (error) {
        await videoMessage({ operation: 'close', id: lease.id }).catch(() => {});
        return { frame: null, error: String(error) };
      }
    }

    case 'cdp.events': {
      const tid = await getTargetTabId(params.tabId);
      const since = params.since ?? 0;
      if (!Number.isSafeInteger(since) || since < 0) throw new Error('since must be a non-negative safe integer');
      let stream = cdpEventStreams.get(tid);
      if (params.streamId != null && params.streamId !== stream?.id) {
        throw new Error('CDP event stream changed or stopped; start a new capture before acting');
      }
      if (params.stop) {
        cdpEventStreams.delete(tid);
        return { tabId: tid, stopped: true };
      }
      if (!stream) {
        stream = newCdpEventStream();
        cdpEventStreams.set(tid, stream);
        try {
          await ensureAttached(tid);
        } catch (error) {
          cdpEventStreams.delete(tid);
          throw error;
        }
        stream = cdpEventStreams.get(tid);
      }
      if (since > stream.cursor) throw new Error('Cursor is ahead of this CDP event stream');
      return {
        tabId: tid,
        streamId: stream.id,
        cursor: stream.cursor,
        dropped: since < stream.droppedThrough,
        attached: attached.has(tid),
        detached: stream.detached,
        events: stream.events.map(item => item.event).filter(event => event.sequence > since
          && (!params.method || event.method === params.method)
          && (!params.sessionId || event.sessionId === params.sessionId)),
      };
    }

    case 'cdp': {
      const tid = await getTargetTabId(params.tabId);
      if (params.leaseId != null) refreshDebuggerLease(tid, params.leaseId);
      if (params.sessionId != null && (typeof params.sessionId !== 'string' || !params.sessionId)) {
        throw new Error('sessionId must be a non-empty string');
      }
      if (params.sessionId && !attached.has(tid)) throw new Error('Parent debugger is detached; attach and discover a new child session');
      await ensureAttached(tid);
      try {
        return await cdpSend(tid, params.method, params.params, params.sessionId);
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
