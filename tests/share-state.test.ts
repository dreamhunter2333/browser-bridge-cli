import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { SHARE_CHANNEL_IDLE_TIMEOUT, shareIdentity, startShare, shareAccess } from '../src/share';

test('stable share identity, active switching and stale input isolation', async () => {
  let active = { id: 1, url: 'https://one.test' };
  let sequence = 0;
  const commands: any[] = [];
  const video = { data: Buffer.from([1, 2, 3]), codec: 'vp8', type: 'key', timestamp: 0, width: 100, height: 100 };
  const decode = (data: Buffer, binary: boolean) => JSON.parse(binary ? data.subarray(4, 4 + data.readUInt32BE(0)).toString() : data.toString());
  const call = async (action: string, params: any = {}) => {
    commands.push({ action, ...params });
    if (action === 'tabs.current') return active;
    if (action === 'tabs.list') return [{ id: 1, url: 'https://one.test/' }, { id: 2, url: 'https://two.test/' }, { id: 3, url: 'chrome://extensions/' }, { id: 4, url: 'https://blocked.example/' }];
    if (action === 'whitelist.get') return { whitelistEnabled: true, whitelist: ['https://*.test/*'] };
    if (action === 'tabs.get') return { id: params.tabId, url: 'https://one.test/' };
    if (action === 'cdp.retain') return { tabId: params.tabId, leaseId: `lease-${params.tabId}` };
    if (action === 'cdp.frames') return params.start ? { video: true } : { frame: { sequence: ++sequence, video, metadata: { deviceWidth: 100 } } };
    return {};
  };
  let session: Awaited<ReturnType<typeof startShare>> | undefined;
  let ws: WebSocket | undefined;
  try {
    const identity = shareIdentity('server/browser/active');
    expect(shareIdentity('server/browser/active')).toEqual(identity);
    expect(shareIdentity('server/browser/1').basePath).not.toBe(identity.basePath);
    session = await startShare(call, { ...identity, host: '127.0.0.1', port: 0, followActive: true });
    const port = (session.server.address() as any).port;
    const messages: any[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}${identity.basePath}stream`);
    ws.on('message', (data, binary) => messages.push(decode(data as Buffer, binary)));
    await new Promise<void>(resolve => ws!.once('open', () => { ws!.send(JSON.stringify({ type: 'hello', video: true })); resolve(); }));
    await expect.poll(() => messages.some(m => m.type === 'frame' && m.tabId === 1)).toBe(true);
    const oldFrame = messages.find(m => m.type === 'frame');
    active = { id: 2, url: 'https://two.test' };
    await expect.poll(() => messages.some(m => m.type === 'frame' && m.tabId === 2)).toBe(true);
    ws.send(JSON.stringify({ type: 'input', geometry: oldFrame.geometry, event: 'text', text: 'stale' }));
    const frame = messages.find(m => m.type === 'frame' && m.tabId === 2);
    ws.send(JSON.stringify({ type: 'input', geometry: frame.geometry, event: 'text', text: 'current' }));
    await expect.poll(() => commands.filter(c => c.method === 'Input.insertText').length).toBe(1);
    expect(commands.find(c => c.method === 'Input.insertText')).toMatchObject({ tabId: 2, params: { text: 'current' } });
    expect(commands.some(c => c.action === 'cdp.release' && c.tabId === 1)).toBe(true);
    active = { id: 3, url: 'chrome://extensions/' };
    await expect.poll(() => messages.some(m => m.type === 'paused' && m.message.includes('不可共享'))).toBe(true);
    expect(commands.some(c => c.action === 'cdp.retain' && c.tabId === 3)).toBe(false);
    active = { id: 2, url: 'https://two.test' };
    await expect.poll(() => commands.filter(c => c.action === 'cdp.retain' && c.tabId === 2).length).toBe(2);
    await session.stop();
    session = await startShare(call, { ...shareIdentity('server/browser/active'), host: '127.0.0.1', port, followActive: true });
    expect(shareIdentity('server/browser/active')).toEqual(identity);
    expect((session.server.address() as any).port).toBe(port);
    await session.stop();
    session = await startShare(call, { ...identity, host: '127.0.0.1', port, tabs: true });
    const browserMessages: any[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}${identity.basePath}stream`);
    ws.on('message', (data, binary) => browserMessages.push(decode(data as Buffer, binary)));
    await new Promise<void>(resolve => ws!.once('open', () => { ws!.send(JSON.stringify({ type: 'hello', video: true })); resolve(); }));
    await expect.poll(() => browserMessages.some(m => m.type === 'tabs')).toBe(true);
    expect(browserMessages.find(m => m.type === 'tabs').tabs.map((t: any) => t.id)).toEqual([1, 2]);
    ws.send(JSON.stringify({ type: 'select-tab', tabId: 1 }));
    await expect.poll(() => browserMessages.some(m => m.type === 'frame' && m.tabId === 1)).toBe(true);
    expect(commands.some(c => c.action === 'tabs.activate' && c.tabId === 1)).toBe(true);

  } finally {
    ws?.terminate();
    await session?.stop();
  }
});


test('local sharing rejects foreign origins and non-local sharing requires login', () => {
  const request = (headers: any) => ({ headers, method: 'GET' }) as any;
  expect(shareAccess(request({ host: '127.0.0.1:52853' }), '127.0.0.1')).toBe(200);
  expect(shareAccess(request({ host: 'attacker.example:52853' }), '127.0.0.1')).toBe(403);
  expect(shareAccess(request({ host: '127.0.0.1:52853', origin: 'https://attacker.example' }), '127.0.0.1')).toBe(403);
  expect(shareAccess(request({ host: '127.0.0.1:52853' }), '0.0.0.0')).toBe(403);
});

test('stop cancels an in-flight frame request before waiting for the poll', async () => {
  let unblock: () => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const call = async (action: string, params: any = {}) => {
    if (action === 'cdp.retain') return { tabId: 1, leaseId: 'lease' };
    if (action === 'cdp.frames' && params.stop) { unblock(); return {}; }
    if (action === 'cdp.frames' && params.start) return { video: true };
    if (action === 'cdp.frames') {
      entered();
      await new Promise<void>(resolve => { unblock = resolve; });
      return { frame: null };
    }
    return {};
  };
  const identity = shareIdentity('cancel-test');
  const session = await startShare(call, { ...identity, host: '127.0.0.1', port: 0, tabId: 1 });
  const ws = new WebSocket(`ws://127.0.0.1:${(session.server.address() as any).port}${identity.basePath}stream`);
  try {
    await new Promise<void>(resolve => ws.once('open', () => { ws.send(JSON.stringify({ type: 'hello', video: true })); resolve(); }));
    await waiting;
    let stopped = false;
    const stop = session.stop().then(() => { stopped = true; });
    await expect.poll(() => stopped, { timeout: 1500 }).toBe(true);
    await stop;
  } finally { unblock(); ws.terminate(); await session.stop(); }
});

test('wheel bursts coalesce without dropping the connection or reordering release', async () => {
  const calls: any[] = [];
  let unblock: () => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const call = async (action: string, params: any = {}) => {
    if (action === 'cdp.retain') return { tabId: 1, leaseId: 'lease' };
    if (action === 'cdp.frames') return params.start ? { video: true } : { frame: { sequence: 1, metadata: { deviceWidth: 100 }, video: { data: Buffer.from([1]), width: 100, height: 100, type: 'key', codec: 'vp8', timestamp: 0 } } };
    if (params.method === 'Input.dispatchMouseEvent') {
      calls.push(params.params);
      if (calls.length === 1) { entered(); await new Promise<void>(resolve => { unblock = resolve; }); }
    }
    return {};
  };
  const identity = shareIdentity('wheel-test');
  const session = await startShare(call, { ...identity, host: '127.0.0.1', port: 0, tabId: 1 });
  const ws = new WebSocket(`ws://127.0.0.1:${(session.server.address() as any).port}${identity.basePath}stream`);
  try {
    const received = new Promise<any>(resolve => ws.on('message', (data: Buffer, binary) => {
      if (binary) resolve(JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)).toString()));
    }));
    await new Promise<void>(resolve => ws.once('open', () => { ws.send(JSON.stringify({ type: 'hello', video: true })); resolve(); }));
    const frame = await received;
    const send = (event: string) => ws.send(JSON.stringify({ type: 'input', geometry: frame.geometry, event, x: 0.5, y: 0.5, deltaX: 0, deltaY: 10 }));
    send('wheel'); await waiting;
    for (let i = 0; i < 100; i++) send('wheel');
    send('up');
    await new Promise<void>(resolve => { ws.once('pong', () => resolve()); ws.ping(); });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    unblock();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls.map(c => c.type)).toEqual(['mouseWheel', 'mouseWheel', 'mouseReleased']);
    expect(calls[1].deltaY).toBe(1000);
  } finally { unblock(); ws.terminate(); await session.stop(); }
});

test('browser share waits for a shareable tab before attaching', async () => {
  let tabs = [{ id: 1, url: 'chrome://extensions/' }];
  let retained = 0, released = 0;
  const call = async (action: string, params: any = {}) => {
    if (action === 'tabs.current') return tabs[0];
    if (action === 'tabs.list') return tabs;
    if (action === 'tabs.get') return tabs.find(tab => tab.id === params.tabId);
    if (action === 'whitelist.get') return { whitelistEnabled: false };
    if (action === 'cdp.retain') { retained++; return { tabId: params.tabId, leaseId: 'lease' }; }
    if (action === 'cdp.frames') return params.start ? { video: true } : { frame: null };
    if (action === 'cdp.release') released++;
    return {};
  };
  const identity = shareIdentity('wait-for-tab');
  const session = await startShare(call, { ...identity, tabs: true, host: '127.0.0.1', port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${(session.server.address() as any).port}${identity.basePath}stream`);
  try {
    await new Promise<void>(resolve => ws.once('open', () => { ws.send(JSON.stringify({ type: 'hello', video: true })); resolve(); }));
    await expect.poll(() => session.paused).toContain('不可共享');
    expect(retained).toBe(0);
    tabs = [{ id: 2, url: 'https://ready.test/' }];
    await expect.poll(() => retained).toBe(1);
    expect(session.capturing).toBe(true);
    ws.close();
    await expect.poll(() => released).toBe(1);
  } finally { ws.terminate(); await session.stop(); }
});

for (const mode of [{ tabId: 1 }, { followActive: true }, { tabs: true }]) {
  test(`share channel idle timeout: ${Object.keys(mode)[0]}`, async () => {
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const timers = new Map<any, () => void>();
    globalThis.setTimeout = ((fn: any, delay: number, ...args: any[]) => {
      const timer = originalSet(fn, delay, ...args);
      if (delay > SHARE_CHANNEL_IDLE_TIMEOUT - 60_000 && delay <= SHARE_CHANNEL_IDLE_TIMEOUT) timers.set(timer, fn);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: any) => { timers.delete(timer); originalClear(timer); }) as typeof clearTimeout;
    let retained = 0, released = 0;
    const call = async (action: string, params: any = {}) => {
      if (action === 'tabs.current' || action === 'tabs.get') return { id: 1, url: 'https://one.test/' };
      if (action === 'tabs.list') return [{ id: 1, url: 'https://one.test/' }];
      if (action === 'whitelist.get') return { whitelistEnabled: false };
      if (action === 'cdp.retain') { retained++; return { tabId: 1, leaseId: 'lease' }; }
      if (action === 'cdp.frames') return params.start ? { video: true } : { frame: null };
      if (action === 'cdp.release') released++;
      return {};
    };
    let session: Awaited<ReturnType<typeof startShare>> | undefined;
    let ws: WebSocket | undefined;
    try {
      const identity = shareIdentity('idle-' + Object.keys(mode)[0]);
      session = await startShare(call, { ...identity, ...mode, host: '127.0.0.1', port: 0 });
      const address = `http://127.0.0.1:${(session.server.address() as any).port}${identity.basePath}`;
      expect(timers.size).toBe(1);
      expect(retained).toBe(0);
      const initialTimer = [...timers.keys()][0];
      await fetch(address + 'status');
      expect(timers.has(initialTimer)).toBe(true);
      expect(retained).toBe(0);
      ws = new WebSocket(address.replace('http', 'ws') + 'stream');
      await new Promise<void>(resolve => ws!.once('open', () => { ws!.send(JSON.stringify({ type: 'hello', video: true })); resolve(); }));
      await expect.poll(() => timers.size).toBe(0);
      await expect.poll(() => retained).toBe(1);
      ws.close();
      await expect.poll(() => timers.size).toBe(1);
      await expect.poll(() => released).toBe(1);
      expect(timers.has(initialTimer)).toBe(false);
      const expire = [...timers.values()][0];
      expire();
      await session.stop();
      expect(timers.size).toBe(0);
    } finally {
      ws?.terminate(); await session?.stop();
      for (const timer of timers.keys()) originalClear(timer);
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    }
  });
}
