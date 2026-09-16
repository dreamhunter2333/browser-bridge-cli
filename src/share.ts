import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { shareView } from './share-view.js';

export type BridgeCall = (action: string, params?: Record<string, unknown>) => Promise<any>;
type Frame = { type: 'frame'; video: { data: Buffer; codec: string; type: string; timestamp: number; width: number; height: number }; tabId: number; geometry: string; width: number; height: number };

export function shareIdentity(identity: string) {
  return { basePath: '/share/' + createHash('sha256').update(identity).digest('hex').slice(0, 24) + '/' };
}

export function localShareHost(host: string) {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

export function shareAccess(req: IncomingMessage, bindHost: string, credentials?: Buffer): number {
    const localOnly = localShareHost(bindHost);
    let host: URL;
    try { host = new URL('http://' + req.headers.host); } catch { return 403; }
    if (localOnly && !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return 403;
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== host.host) return 403; } catch { return 403; }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.method !== 'GET') return 403;
    if (!credentials) return localOnly ? 200 : 403;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return 401;
    const supplied = createHash('sha256').update(Buffer.from(header.slice(6), 'base64')).digest();
    return timingSafeEqual(credentials, supplied) ? 200 : 401;
  }

export async function startShare(call: BridgeCall, opts: { tabId?: number; followActive?: boolean; tabs?: boolean; username?: string; password?: string; authHash?: string; server?: Server; onStop?: () => void; basePath: string; host: string; port: number }) {
  const { basePath } = opts;
  const localOnly = localShareHost(opts.host);
  if ((!localOnly || opts.username || opts.password) && !opts.authHash && (!opts.username || !opts.password)) throw new Error('Non-local listeners require --username and --password-env');
  const credentials = opts.authHash ? Buffer.from(opts.authHash, 'hex') : opts.username && opts.password ? createHash('sha256').update(opts.username + ':' + opts.password).digest() : undefined;
  const access = (req: IncomingMessage) => shareAccess(req, opts.host, credentials);
  let generation = 0, switching = true, paused = '';
  let forceKey = true;
  let selectedId: number | undefined;
  let selectionInitialized = false;
  let requestedTab: number | undefined, lastTabsAt = 0, tabList: any[] = [], tabsPayload = "";
  const dynamic = opts.followActive || opts.tabs;
  let closed = false, controller: WebSocket | undefined, latest: Frame | undefined;
  let delivered: Frame | undefined;
  let pressed = false, lastX = 0, lastY = 0, inputQueue = Promise.resolve(), queued = 0;
  let pendingMotion: any;
  const heldKeys = new Map<string, Record<string, unknown>>();
  let leaseId = '', tabId = opts.tabId;
  let poll: Promise<void> | undefined;
  let acquired = false;
  const sockets = new Set<WebSocket>();
  const alive = new Set<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!alive.delete(ws)) { ws.terminate(); continue; }
      ws.ping();
    }
  }, 15000);
  const cdp = (method: string, params: Record<string, unknown> = {}) => call('cdp', { tabId, method, params, keepAttached: true, leaseId });
  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const permission = access(req);
    if (permission !== 200) {
      if (permission === 401) res.setHeader('WWW-Authenticate', 'Basic realm="Browser Bridge Share", charset="UTF-8"');
      res.writeHead(permission); res.end(permission === 401 ? 'Login required' : 'Forbidden'); return;
    }
    if (req.method === 'GET' && req.url === basePath) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
      res.end(shareView);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === basePath + 'status') {
      res.end(JSON.stringify({ tabId: tabId ?? null, mode: opts.tabs ? 'browser' : opts.followActive ? 'active' : 'tab', paused, transport: 'vp8', connected: !!controller, running: !closed }));
      return;
    }
    if (req.method === 'POST' && req.url === basePath + 'stop') {
      void stop(() => res.end(JSON.stringify({ stopped: true })));
      return;
    }
    res.writeHead(404); res.end('{}');
  };
  const server = opts.server || createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  const handleUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const permission = access(req);
    if (permission !== 200) { socket.end(`HTTP/1.1 ${permission} Forbidden\r\nConnection: close\r\n\r\n`); return; }
    if (req.url !== basePath + 'stream' || sockets.size >= 8 || closed) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  };
  if (!opts.server) server.on('upgrade', handleUpgrade);
  function error(ws: WebSocket, reason: string, fatal = false) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', error: reason, fatal }));
  }
  async function release() {
    const keys = [...heldKeys.values()];
    heldKeys.clear();
    for (const key of keys) await cdp('Input.dispatchKeyEvent', { ...key, type: 'keyUp', modifiers: 0 }).catch(() => {});
    if (pressed) {
      pressed = false;
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, x: lastX, y: lastY, clickCount: 1 });
    }
  }
  async function input(m: any) {
    if (switching || !latest) return;
    if (m.geometry !== latest.geometry) { await release(); return; }
    if (opts.followActive && (await call('tabs.current')).id !== tabId) return;
    if (m.event === 'release') { await release(); return; }
    if (m.event === 'text') {
      if (typeof m.text !== 'string' || !m.text.length || m.text.length > 4096) throw new Error('Invalid text');
      await cdp('Input.insertText', { text: m.text });
      return;
    }
    if (m.event === 'key') {
      if (!['down', 'up'].includes(m.phase) || typeof m.key !== 'string' || m.key.length > 40 || typeof m.code !== 'string' || !m.code || m.code.length > 40
        || !Number.isInteger(m.keyCode) || m.keyCode < 0 || m.keyCode > 255 || !Number.isInteger(m.modifiers) || m.modifiers < 0 || m.modifiers > 15) throw new Error('Invalid key');
      const key = { key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode };
      if (m.phase === 'up' && !heldKeys.has(m.code)) return;
      if (m.phase === 'down') heldKeys.set(m.code, key);
      else heldKeys.delete(m.code);
      await cdp('Input.dispatchKeyEvent', {
        ...key, type: m.phase === 'down' ? (m.key === 'Enter' ? 'keyDown' : 'rawKeyDown') : 'keyUp', modifiers: m.modifiers,
        ...(m.phase === 'down' && m.key === 'Enter' && !m.modifiers ? { text: '\r', unmodifiedText: '\r' } : {}),
      });
      return;
    }
    if (!latest || m.geometry !== latest.geometry) { await release(); throw new Error('Viewport changed; retry on the new frame'); }
    if (!['down', 'up', 'move', 'wheel'].includes(m.event)) throw new Error('Unsupported input');
    if (![m.x, m.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid coordinates');
    if (m.event === 'wheel' && ![m.deltaX, m.deltaY].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 2000)) throw new Error('Invalid wheel delta');
    lastX = m.x * Math.max(0, latest.width - 1); lastY = m.y * Math.max(0, latest.height - 1);
    if (m.event === 'down') pressed = true;
    if (m.event === 'up') pressed = false;
    await cdp('Input.dispatchMouseEvent', {
      type: ({ down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' } as Record<string, string>)[m.event],
      x: lastX, y: lastY, button: m.event === 'wheel' ? 'none' : 'left', buttons: pressed ? 1 : 0,
      ...(m.event === 'down' || m.event === 'up' ? { clickCount: 1 } : {}),
      ...(m.event === 'wheel' ? { deltaX: m.deltaX, deltaY: m.deltaY } : {}),
    });
  }
  wss.on('connection', ws => {
    sockets.add(ws);
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    const timeout = setTimeout(() => ws.close(1008, 'Connection setup timeout'), 5000);
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (controller !== ws) {
          if (m.type !== 'hello' || controller) { ws.close(1008, 'Invalid session or controller already connected'); return; }
          if (m.video !== true) { error(ws, '观看端不支持 WebCodecs VP8，请使用支持的浏览器和 localhost 或 HTTPS', true); ws.close(1003, 'VP8 required'); return; }
          forceKey = true;
          clearTimeout(timeout); controller = ws; delivered = latest; tabsPayload = ""; lastTabsAt = 0;
          if (paused) ws.send(JSON.stringify({ type: 'paused', message: paused }));
          return;
        }
        if (m.type === 'select-tab' && opts.tabs && !closed) {
          if (!Number.isSafeInteger(m.tabId) || !tabList.some(t => t.id === m.tabId)) throw new Error('Unknown tab');
          requestedTab = m.tabId; switching = true;
          return;
        }
        if (m.type !== 'input' || closed) return;
        const motion = m.event === 'move' || m.event === 'wheel';
        if (motion && pendingMotion?.event === m.event && pendingMotion.geometry === m.geometry) {
          if (m.event === 'wheel' && [m.deltaX, m.deltaY].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 2000)) {
            pendingMotion.deltaX = Math.max(-2000, Math.min(2000, pendingMotion.deltaX + m.deltaX));
            pendingMotion.deltaY = Math.max(-2000, Math.min(2000, pendingMotion.deltaY + m.deltaY));
          } else if (m.event === 'wheel') throw new Error('Invalid wheel delta');
          pendingMotion.x = m.x; pendingMotion.y = m.y;
          return;
        }
        pendingMotion = motion ? m : undefined;
        if (queued >= 64) { ws.close(1008, 'Input queue full'); return; }
        queued++;
        inputQueue = inputQueue.then(async () => { if (pendingMotion === m) pendingMotion = undefined; if (controller === ws && !closed) await input(m); }).catch(e => error(ws, String(e.message || e))).finally(() => { queued--; });
      } catch { ws.close(1008, 'Invalid message'); }
    });
    ws.on('close', () => {
      clearTimeout(timeout); sockets.delete(ws); alive.delete(ws);
      if (controller !== ws) return;
      controller = undefined;
      inputQueue = inputQueue.then(release).catch(() => {});
    });
  });
  let stopPromise: Promise<void> | undefined;
  function stop(respond?: () => void) {
    if (stopPromise) { respond?.(); return stopPromise; }
    closed = true;
    clearInterval(heartbeat);
    stopPromise = (async () => {
      for (const ws of sockets) ws.terminate();
      const cancelling = acquired ? call('cdp.frames', { tabId, leaseId, stop: true }).catch(() => {}) : Promise.resolve();
      await poll;
      await cancelling;
      await inputQueue;
      await release().catch(() => {});
      if (acquired) {
        await call('cdp.release', { tabId, leaseId }).catch(() => {});
      }
      wss.close();
      respond?.();
      if (!opts.server) await new Promise<void>(resolve => server.close(() => resolve()));
      opts.onStop?.();
    })();
    return stopPromise;
  }
  async function selectTab(id?: number, url?: string) {
    switching = true;
    generation++;
    latest = undefined; delivered = undefined;
    paused = '正在切换共享标签页';
    if (controller?.readyState === WebSocket.OPEN) controller.send(JSON.stringify({ type: 'paused', message: paused }));
    await inputQueue;
    await release().catch(() => {});
    if (acquired) await call('cdp.release', { tabId, leaseId }).catch(() => {});
    acquired = false; leaseId = ''; tabId = id;
    try {
      if (id == null || (url != null && !/^https?:/.test(url) && url !== 'about:blank')) throw new Error('当前标签页不可共享，请切换到网页');
      const lease = await call('cdp.retain', { tabId });
      leaseId = lease.leaseId; tabId = lease.tabId; acquired = true;
      const capture = await call('cdp.frames', { tabId, leaseId, start: true });
      if (capture.video !== true) throw new Error('WebCodecs 串流不可用，请重新加载最新版扩展');
      forceKey = true;
      paused = ''; switching = false;
    } catch (e: any) {
      if (!dynamic || String(e.message || e).includes('WebCodecs')) throw e;
      if (acquired) await call('cdp.release', { tabId, leaseId }).catch(() => {});
      acquired = false; latest = undefined;
      paused = String(e.message || e);
      if (controller?.readyState === WebSocket.OPEN) controller.send(JSON.stringify({ type: 'paused', message: paused }));
    }
  }
  try {
    if (!opts.server) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.host, () => { server.off('error', reject); resolve(); }); });
    if (!dynamic) await selectTab(opts.tabId!);
    let sequence = 0;
    poll = (async () => {
      while (!closed) {
        if (opts.tabs && Date.now() - lastTabsAt >= 500) {
          const policy = await call('whitelist.get');
          tabList = (await call('tabs.list')).filter((t: any) => {
            if (!/^https?:/.test(t.url || '')) return false;
            if (policy.whitelistEnabled && !policy.whitelist.some((pattern: string) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(t.url))) return false;
            try {
              const url = new URL(t.url);
              return !(url.pathname.startsWith('/share/') && Number(url.port) === (server.address() as any)?.port);
            } catch { return false; }
          });
          lastTabsAt = Date.now();
        }
        if (dynamic) {
          let target;
          const hasSelection = requestedTab !== undefined;
          if (opts.tabs && requestedTab !== undefined) {
            const id = requestedTab; requestedTab = undefined;
            await call('tabs.activate', { tabId: id });
            target = await call('tabs.get', { tabId: id });
          } else if (opts.tabs && selectedId !== undefined) {
            target = tabList.find(t => t.id === selectedId) || tabList[0] || { id: undefined, url: '' };
          } else {
            target = await call('tabs.current');
            if (opts.tabs) target = tabList.find(t => t.id === target.id) || tabList[0] || { id: undefined, url: '' };
          }
          if (!selectionInitialized || selectedId !== target.id || hasSelection || (!acquired && (/^https?:/.test(target.url || '') || target.url === 'about:blank'))) {
            selectionInitialized = true; selectedId = target.id;
            sequence = 0;
            await selectTab(target.id, target.url);
          }
        }
        if (opts.tabs && controller?.readyState === WebSocket.OPEN) {
          const payload = JSON.stringify({ type: 'tabs', selectedId, tabs: tabList.map(t => ({ id: t.id, title: t.title || t.url || '新标签页', url: t.url || '' })) });
          if (payload !== tabsPayload) { controller.send(payload); tabsPayload = payload; }
        }
        if (!acquired) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
        let frame;
        try {
          const result = await call('cdp.frames', { tabId, leaseId, since: sequence, keyFrame: forceKey, idle: !controller || controller.bufferedAmount >= 512 * 1024 || !!(latest && latest !== delivered) });
          frame = result.frame;
          if (result.error) throw new Error('WebCodecs: ' + result.error);
        }
        catch (e) {
          if (closed) break;
          if (!dynamic || String(e).includes('WebCodecs')) throw e;
          await selectTab(undefined);
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }
        if (frame) {
          sequence = frame.sequence;
          const { deviceWidth: width } = frame.metadata;
          // The image excludes browser top controls; deviceHeight may include them.
          const height = width * frame.video.height / frame.video.width;
          latest = { type: 'frame', tabId: tabId!, video: frame.video, width, height, geometry: `${generation}:${tabId}:${width}:${height}` };
        }
        if (latest && latest !== delivered && controller?.readyState === WebSocket.OPEN && controller.bufferedAmount < 512 * 1024) {
          const { data, ...video } = latest.video;
          const header = Buffer.from(JSON.stringify({ ...latest, video }));
          const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
          controller.send(Buffer.concat([length, header, data]));
          forceKey = false;
          delivered = latest;
        }
        await new Promise(resolve => setTimeout(resolve, 67));
      }
    })();
    void poll.catch(e => {
      console.error(`Share stopped: ${e.message}`);
      if (controller) error(controller, e.message, true);
      // Run cleanup outside the polling promise so it cannot wait on itself.
      setTimeout(() => { void stop(); }, 0);
    });
    // Cleanup must also work after a failed polling request.
    poll = poll.catch(() => {});
    return { server, tabId, stop, handleRequest, handleUpgrade };
  } catch (e) { await stop(); throw e; }
}
