import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { startServer, stopServer, launchBrowserWithExtension, getExtensionPopup, generateCode, apiCall, stateEnv, runCli } from './helpers';

test('CLI share: streaming, all tab modes, input, authentication and stop', async ({ browser }) => {
  test.setTimeout(120000);
  const bridge = await startServer();
  let context: Awaited<ReturnType<typeof launchBrowserWithExtension>> | undefined;
  let proc: ChildProcess | undefined;
  const site = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<body style="margin:0;height:3000px;background:#336699"><button style="position:absolute;left:100px;top:100px;width:200px;height:100px" onclick="this.textContent='Clicked'">Click me</button><div id="drag" style="position:absolute;top:220px;left:100px;width:200px;height:100px;background:#ffeeaa" onpointerdown="this.setPointerCapture(event.pointerId)" onpointermove="if(event.buttons)this.textContent='Dragged'">Drag me</div><input id="text" style="position:absolute;top:340px;left:100px;width:400px;height:40px"><textarea id="multiline" style="position:absolute;top:400px;left:100px;width:400px;height:80px"></textarea></body>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  try {
    context = await launchBrowserWithExtension(`ws://127.0.0.1:${bridge.port}/ext`);
    const popup = await getExtensionPopup(context);
    if (!(await popup.locator('#enabledToggle').isChecked())) await popup.locator('#enabledToggle').evaluate((el: HTMLInputElement) => el.click());
    await popup.locator('#urlInput2').fill(`ws://127.0.0.1:${bridge.port}/ext`);
    const code = await generateCode(bridge.baseUrl, bridge.token);
    for (let i = 0; i < 6; i++) await popup.locator('#codeBoxes input').nth(i).fill(code[i]);
    await popup.locator('#pairBtn').click();
    await expect(popup.locator('#statusMain')).toContainText('Connected', { timeout: 30000 });
    await popup.close();
    const target = await context.newPage();
    const sitePort = (site.address() as import('node:net').AddressInfo).port;
    await target.goto(`http://127.0.0.1:${sitePort}`);
    const tabs = (await apiCall(bridge.baseUrl, bridge.token, 'tabs.list')).body.data as any[];
    const tabId = tabs.find(t => t.url === target.url()).id;
    let output = '', errors = '';
    proc = spawn('node', ['dist/cli.js', '--server', bridge.baseUrl, '--token', bridge.token, 'share', 'start'], { env: { ...process.env, ...stateEnv(bridge.stateDir) }, stdio: 'pipe' });
    proc.stdout!.on('data', d => output += d);
    proc.stderr!.on('data', d => errors += d);
    await expect.poll(() => { if (proc!.exitCode !== null && proc!.exitCode !== 0) throw new Error(errors); try { return JSON.parse(output).links?.tab?.url; } catch { return ''; } }).not.toBe('');
    const { links } = JSON.parse(output);
    const url = links.tab.url;
    expect(Object.keys(links)).toEqual(['tab', 'active', 'browser']);
    const lookup = await runCli(['share', 'links', '--tab', String(tabId)], stateEnv(bridge.stateDir));
    expect(lookup.code, lookup.stderr).toBe(0);
    expect(JSON.parse(lookup.stdout).links).toEqual(links);
    expect(new URL(url).hash).toBe('');
    const base = new URL(url).origin;
    expect((await fetch(`${base}${new URL(url).pathname}status`)).status).toBe(200);
    const denied = new WebSocket(`${base.replace('http', 'ws')}${new URL(url).pathname}stream`);
    denied.on('open', () => denied.send(JSON.stringify({ type: 'invalid' })));
    expect(await new Promise(resolve => denied.on('close', code => resolve(code)))).toBe(1008);
    const viewer = await browser.newPage({ viewport: { width: 900, height: 650 } });
    const pageErrors: string[] = [];
    const videoKinds: string[] = [];
    viewer.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      if (Buffer.isBuffer(payload)) {
        const size = payload.readUInt32BE(0);
        videoKinds.push(JSON.parse(payload.subarray(4, 4 + size).toString()).video.type);
      }
    }));
    viewer.on('pageerror', e => pageErrors.push(e.message));
    await viewer.goto(url);
    await expect(viewer.locator('canvas')).toBeVisible({ timeout: 10000 }).catch(async e => {
      console.error({ errors, pageErrors, videoKinds, state: await viewer.locator('#status').textContent() });
      const events = await apiCall(bridge.baseUrl, bridge.token, 'cdp.events', { tabId, method: 'Page.screencastFrame' });
      console.error(JSON.stringify(events).slice(0, 800));
      throw e;
    });
    await expect(viewer.locator('#status')).toContainText('已连接');
    await expect(viewer.locator('canvas')).toHaveAttribute('data-transport', 'vp8');
    for (let i = 0; i < 6; i++) {
      const color = i % 2 ? '#10e020' : '#e01020';
      await target.locator('button').evaluate((el, color) => { el.style.background = color; }, color);
      await expect.poll(() => viewer.locator('canvas').evaluate((c: HTMLCanvasElement) => {
        const p = c.getContext('2d')!.getImageData(110, 110, 1, 1).data;
        return p[1] > p[0];
      })).toBe(!!(i % 2));
    }
    expect(videoKinds).toContain('key'); expect(videoKinds).toContain('delta');
    const pixel = await viewer.locator('canvas').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(20, 20, 1, 1).data));
    expect(pixel[2]).toBeGreaterThan(pixel[0]);
    const command = (args: string[]) => runCli(['--server', bridge.baseUrl, '--token', bridge.token, ...args, '-t', String(tabId)], stateEnv(bridge.stateDir));
    const commands = await Promise.all([
      command(['eval', 'document.title']),
      command(['query', 'button']),
      command(['screenshot', '-o', test.info().outputPath('concurrent.png')]),
      command(['cdp', 'DOM.getDocument']),
      command(['cookies']),
    ]);
    for (const result of commands) expect(result.code, result.stderr).toBe(0);
    const detached = await command(['detach']);
    expect(detached.code, detached.stderr).toBe(0);
    expect((await command(['cdp-events', '--stop'])).code).toBe(0);
    expect((await command(['eval', "document.body.style.background='#993322'"])).code).toBe(0);
    await expect.poll(() => viewer.locator('canvas').evaluate((c: HTMLCanvasElement) => {
      const pixel = c.getContext('2d')!.getImageData(20, 20, 1, 1).data;
      return pixel[0] > pixel[2];
    })).toBe(true);
    async function position(x: number, y: number) {
      const box = await viewer.locator('canvas').boundingBox();
      const size = target.viewportSize()!;
      return { x: box!.x + x / size.width * box!.width, y: box!.y + y / size.width * box!.width };
    }
    let p = await position(200, 150);
    await viewer.mouse.click(p.x, p.y);
    await expect(target.locator('button')).toHaveText('Clicked');
    p = await position(200, 360);
    await viewer.mouse.click(p.x, p.y);
    await viewer.keyboard.type('hello');
    await expect(target.locator('#text')).toHaveValue('hello');
    await viewer.keyboard.press('ArrowLeft');
    await viewer.keyboard.press('Backspace');
    await expect(target.locator('#text')).toHaveValue('helo');
    await target.locator('#text').evaluate(el => {
      el.addEventListener('keydown', e => el.setAttribute('data-key', JSON.stringify({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey })));
    });
    await viewer.keyboard.press('Control+a');
    await expect(target.locator('#text')).toHaveAttribute('data-key', JSON.stringify({ key: 'a', ctrl: true, meta: false }));
    await target.locator('#text').evaluate((el: HTMLInputElement) => el.select());
    await viewer.keyboard.insertText('右侧输入中文');
    await expect(target.locator('#text')).toHaveValue('右侧输入中文');
    await viewer.locator('#keyboard').evaluate((el: HTMLTextAreaElement) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      el.value = '输入法';
      el.dispatchEvent(new InputEvent('input', { data: '输入法', isComposing: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { data: '输入法' }));
      el.dispatchEvent(new InputEvent('input', { data: '输入法' }));
    });
    await expect(target.locator('#text')).toHaveValue('右侧输入中文输入法');
    await viewer.keyboard.press('Tab');
    await viewer.keyboard.type('line1');
    await viewer.keyboard.press('Enter');
    await viewer.keyboard.type('line2');
    await expect(target.locator('#multiline')).toHaveValue('line1\nline2');
    const other = await context.newPage();
    await other.goto(`http://127.0.0.1:${sitePort}/other`);
    p = await position(150, 260);
    await viewer.mouse.move(p.x, p.y); await viewer.mouse.down(); await viewer.mouse.move(p.x + 30, p.y + 10); await viewer.mouse.up();
    await expect(target.locator('#drag')).toHaveText('Dragged');
    await expect(other.locator('#drag')).toHaveText('Drag me');
    await viewer.setViewportSize({ width: 480, height: 800 });
    p = await position(300, 400); await viewer.mouse.move(p.x, p.y); await viewer.mouse.wheel(0, 500);
    await expect.poll(() => target.evaluate(() => scrollY)).toBeGreaterThan(100);
    const second = await browser.newPage(); await second.goto(url);
    await expect(second.locator('#status')).toContainText('连接已关闭'); await second.close();
    const status = await runCli(['share', 'status', url], stateEnv(bridge.stateDir));
    expect(JSON.parse(status.stdout)).toMatchObject({ tabId, connected: true, running: true });
    await viewer.reload();
    await expect(viewer.locator('canvas')).toBeVisible();
    await expect(viewer.locator('canvas')).toHaveAttribute('data-transport', 'vp8');
    await viewer.close();
    const freshContext = await browser.newContext();
    const freshViewer = await freshContext.newPage();
    await freshViewer.addInitScript(() => { Object.defineProperty(window, 'VideoDecoder', { value: undefined }); });
    await freshViewer.goto(url);
    await expect(freshViewer.locator('#status')).toContainText('不支持 WebCodecs');
    await expect(freshViewer.locator('canvas')).toBeHidden();
    const stop = await runCli(['share', 'stop', url], stateEnv(bridge.stateDir));
    expect(stop.code).toBe(0);
    await expect.poll(() => proc!.exitCode).toBe(0);
    expect(pageErrors).toEqual([]);
    await freshContext.close();
    expect((await runCli(['info'], stateEnv(bridge.stateDir))).code).toBe(0);
    const authEnv = { ...stateEnv(bridge.stateDir), BROWSER_BRIDGE_SHARE_PASSWORD: 'test-only-password' };
    const protectedShare = await runCli(['share', 'links', '--tab', String(tabId), '--username', 'test-user'], authEnv);
    expect(protectedShare.code, protectedShare.stderr).toBe(0);
    const protectedUrl = JSON.parse(protectedShare.stdout).links.tab.url;
    expect(protectedUrl).toBe(url);
    expect((await fetch(url)).status).toBe(401);
    const authContext = await browser.newContext({ httpCredentials: { username: 'test-user', password: 'test-only-password' } });
    const authViewer = await authContext.newPage();
    await authViewer.goto(url);
    await expect(authViewer.locator('canvas')).toBeVisible();
    await authContext.close();
    for (const link of Object.values(JSON.parse(protectedShare.stdout).links) as any[]) {
      expect((await runCli(['share', 'stop', link.url, '--username', 'test-user'], authEnv)).code).toBe(0);
    }
    {
      const result = await runCli(['share', 'start'], stateEnv(bridge.stateDir));
      expect(result.code, result.stderr).toBe(0);
      const tabsUrl = JSON.parse(result.stdout).links.browser.url;
      const tabsViewer = await browser.newPage();
      await tabsViewer.goto(tabsUrl);
      const allTabs = (await apiCall(bridge.baseUrl, bridge.token, 'tabs.list')).body.data as any[];
      const otherId = allTabs.find(t => t.url === other.url()).id;
      for (const id of [tabId, otherId, tabId]) {
        await tabsViewer.locator(`[data-id="${id}"]`).click();
        await expect(tabsViewer.locator(`[data-id="${id}"]`)).toHaveAttribute('aria-selected', 'true');
        await expect(tabsViewer.locator('canvas')).toBeVisible();
        await expect(tabsViewer.locator('canvas')).toHaveAttribute('data-transport', 'vp8');
        await expect.poll(async () => (await (await fetch(tabsUrl + 'status')).json()).tabId).toBe(id);
      }
      await tabsViewer.addInitScript(() => { VideoDecoder.prototype.decode = () => { throw new Error('Simulated codec failure'); }; });
      await tabsViewer.reload();
      await expect(tabsViewer.locator('#status')).toContainText('串流解码失败');
      await expect(tabsViewer.locator('canvas')).toBeHidden();
      await tabsViewer.close();
      const activeResult = await runCli(['share', 'links'], stateEnv(bridge.stateDir));
      expect(activeResult.code, activeResult.stderr).toBe(0);
      const activeUrl = JSON.parse(activeResult.stdout).links.active.url;
      const activeViewer = await browser.newPage();
      await activeViewer.goto(activeUrl);
      await expect(activeViewer.locator('canvas')).toBeVisible();
      expect((await runCli(['share', 'stop', tabsUrl], stateEnv(bridge.stateDir))).code).toBe(0);
      for (const id of [otherId, tabId]) {
        await apiCall(bridge.baseUrl, bridge.token, 'tabs.activate', { tabId: id });
        await expect.poll(async () => (await (await fetch(activeUrl + 'status')).json()).tabId).toBe(id);
        await expect(activeViewer.locator('canvas')).toBeVisible();
        await expect(activeViewer.locator('canvas')).toHaveAttribute('data-transport', 'vp8');
      }
      await activeViewer.close();
      expect((await runCli(['share', 'stop', activeUrl], stateEnv(bridge.stateDir))).code).toBe(0);

    }


  } finally {
    proc?.kill('SIGTERM');
    await context?.close(); stopServer(bridge);
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});
