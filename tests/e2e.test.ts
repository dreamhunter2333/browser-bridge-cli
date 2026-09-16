import { test, expect } from '@playwright/test';
import { startServer, stopServer, apiCall, httpPair, generateCode, launchBrowserWithExtension, getExtensionPopup, nextPort, runCli, stateEnv, makeTempStateEnv, type ServerInstance } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function readPngSize(file: string): { width: number; height: number } {
  const data = fs.readFileSync(file);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

async function readPngPixel(
  context: Awaited<ReturnType<typeof launchBrowserWithExtension>>,
  file: string,
  x: number,
  y: number
): Promise<[number, number, number, number]> {
  const image = fs.readFileSync(file).toString('base64');
  const page = await context.newPage();
  try {
    await page.setContent(`<img id="capture" src="data:image/png;base64,${image}">`);
    await page.locator('#capture').evaluate(async (image: HTMLImageElement) => {
      if (image.complete && image.naturalWidth > 0) return;
      await image.decode();
    });
    return await page.evaluate(
      ({ x, y }) => {
        const image = document.querySelector('#capture') as HTMLImageElement;
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');
        ctx.drawImage(image, 0, 0);
        return Array.from(ctx.getImageData(x, y, 1, 1).data) as [number, number, number, number];
      },
      { x, y }
    );
  } finally {
    await page.close();
  }
}

// ============================================================
// 1. Server HTTP API basics
// ============================================================

test.describe('Server HTTP API', () => {
  let s: ServerInstance;
  test.beforeAll(async () => { s = await startServer(); });
  test.afterAll(() => stopServer(s));

  test('health without auth returns base fields only', async () => {
    const res = await fetch(`${s.baseUrl}/api/health`);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.clients).toBeUndefined();
  });

  test('health with auth returns clients list', async () => {
    const res = await fetch(`${s.baseUrl}/api/health`, {
      headers: { 'X-Browser-Bridge': s.token },
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.clients).toBeDefined();
    expect(Array.isArray(json.clients)).toBe(true);
  });

  test('/api/clients without auth returns 403', async () => {
    const res = await fetch(`${s.baseUrl}/api/clients`);
    expect(res.status).toBe(403);
  });

  test('/api/clients with auth returns list', async () => {
    const res = await fetch(`${s.baseUrl}/api/clients`, {
      headers: { 'X-Browser-Bridge': s.token },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.clients).toBeDefined();
  });

  test('/api/execute without auth returns 403', async () => {
    const res = await fetch(`${s.baseUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pair.request' }),
    });
    expect(res.status).toBe(403);
  });

  test('/api/execute pair.request returns code', async () => {
    const { status, body } = await apiCall(s.baseUrl, s.token, 'pair.request');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as { code: string }).code).toMatch(/^\d{6}$/);
  });

  test('OPTIONS returns 204', async () => {
    const res = await fetch(`${s.baseUrl}/api/execute`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  test('unknown route returns 404', async () => {
    const res = await fetch(`${s.baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 2. HTTP Pair flow
// ============================================================

test.describe('HTTP Pair', () => {
  let s: ServerInstance;
  test.beforeAll(async () => { s = await startServer(); });
  test.afterAll(() => stopServer(s));

  test('pair with valid code returns token', async () => {
    const code = await generateCode(s.baseUrl, s.token);
    const { status, body } = await httpPair(s.baseUrl, code, 'test-cli-1');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.name).toBe('test-cli-1');
  });

  test('paired client token can call /api/execute', async () => {
    const code = await generateCode(s.baseUrl, s.token);
    const pair = await httpPair(s.baseUrl, code, 'auth-test-cli');
    const { status } = await apiCall(s.baseUrl, pair.body.token as string, 'client.list');
    expect(status).toBe(200);
  });

  test('duplicate name returns 409', async () => {
    const code1 = await generateCode(s.baseUrl, s.token);
    await httpPair(s.baseUrl, code1, 'dup-name');
    const code2 = await generateCode(s.baseUrl, s.token);
    const { status, body } = await httpPair(s.baseUrl, code2, 'dup-name');
    expect(status).toBe(409);
    expect(body.error).toContain('already taken');
  });

  test('missing code returns 400', async () => {
    const res = await fetch(`${s.baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-code' }),
    });
    expect(res.status).toBe(400);
  });

  test('wrong code returns 403', async () => {
    const s2 = await startServer();
    const { status } = await httpPair(s2.baseUrl, '000000', 'wrong-code-cli');
    expect(status).toBe(403);
    stopServer(s2);
  });

  test('dup name check before code consumption', async () => {
    const s2 = await startServer();
    const code = await generateCode(s2.baseUrl, s2.token);
    const name = 'dup-order-test';
    const code1 = await generateCode(s2.baseUrl, s2.token);
    await httpPair(s2.baseUrl, code1, name);
    const { status } = await httpPair(s2.baseUrl, code, name);
    expect(status).toBe(409);
    const { status: s3 } = await httpPair(s2.baseUrl, code, 'dup-order-new');
    expect(s3).toBe(200);
    stopServer(s2);
  });
});

// ============================================================
// 3. Rate Limiting
// ============================================================

test.describe('Rate Limiting', () => {
  let s: ServerInstance;
  test.beforeAll(async () => { s = await startServer(); });
  test.afterAll(() => stopServer(s));

  test('6th attempt within window returns 429', async () => {
    for (let i = 0; i < 5; i++) {
      await httpPair(s.baseUrl, '000000', `rl-${i}`);
    }
    const { status } = await httpPair(s.baseUrl, '000000', 'rl-blocked');
    expect(status).toBe(429);
  });
});

// ============================================================
// 4. Token Revoke
// ============================================================

test.describe('Token Revoke', () => {
  let s: ServerInstance;
  test.beforeAll(async () => { s = await startServer(); });
  test.afterAll(() => stopServer(s));

  test('serverToken can revoke a client token', async () => {
    const code = await generateCode(s.baseUrl, s.token);
    const pair = await httpPair(s.baseUrl, code, 'revoke-target');
    const clientToken = pair.body.token as string;

    const canUse = await apiCall(s.baseUrl, clientToken, 'client.list');
    expect(canUse.status).toBe(200);

    const revoke = await apiCall(s.baseUrl, s.token, 'token.revoke', { name: 'revoke-target' });
    expect(revoke.status).toBe(200);

    const cantUse = await apiCall(s.baseUrl, clientToken, 'client.list');
    expect(cantUse.status).toBe(403);
  });

  test('clientToken cannot revoke another client', async () => {
    const code1 = await generateCode(s.baseUrl, s.token);
    const a = await httpPair(s.baseUrl, code1, 'client-a');
    const code2 = await generateCode(s.baseUrl, s.token);
    await httpPair(s.baseUrl, code2, 'client-b');

    const revoke = await apiCall(s.baseUrl, a.body.token as string, 'token.revoke', { name: 'client-b' });
    expect(revoke.body.error).toContain('revoke');
  });

  test('revoke nonexistent name is idempotent', async () => {
    const { status, body } = await apiCall(s.baseUrl, s.token, 'token.revoke', { name: 'does-not-exist' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ============================================================
// 4b. Privilege Escalation Prevention
// ============================================================

test.describe('Privilege Controls', () => {
  let s: ServerInstance;
  test.beforeAll(async () => { s = await startServer(); });
  test.afterAll(() => stopServer(s));

  test('clientToken cannot generate pairing codes', async () => {
    const code = await generateCode(s.baseUrl, s.token);
    const pair = await httpPair(s.baseUrl, code, 'priv-test');
    const clientToken = pair.body.token as string;
    const res = await fetch(`${s.baseUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Browser-Bridge': clientToken },
      body: JSON.stringify({ action: 'pair.request' }),
    });
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('server token');
  });

  test('clientToken can self-revoke', async () => {
    const code = await generateCode(s.baseUrl, s.token);
    const pair = await httpPair(s.baseUrl, code, 'self-revoke-test');
    const clientToken = pair.body.token as string;
    const { status } = await apiCall(s.baseUrl, clientToken, 'token.revoke', { name: 'self-revoke-test' });
    expect(status).toBe(200);
    const { status: s2 } = await apiCall(s.baseUrl, clientToken, 'client.list');
    expect(s2).toBe(403);
  });
});

// ============================================================
// 5. WebSocket Extension Pair (Playwright)
// ============================================================

test.describe('Extension via Playwright', () => {
  let s: ServerInstance;
  let context: Awaited<ReturnType<typeof launchBrowserWithExtension>>;

  test.beforeAll(async () => {
    s = await startServer();
    context = await launchBrowserWithExtension(`ws://127.0.0.1:${s.port}/ext`);
  });
  test.afterAll(async () => {
    await context?.close();
    stopServer(s);
  });

  test('extension popup loads and shows disabled state', async () => {
    const popup = await getExtensionPopup(context);
    expect(popup.url()).toMatch(/^chrome-extension:\/\//);
    const text = await popup.locator('#statusMain').textContent();
    expect(text).toBeTruthy();
    await popup.close();
  });

  test('extension pair via popup', async ({ }, testInfo) => {
    testInfo.setTimeout(90_000);
    const popup = await getExtensionPopup(context);

    const isChecked = await popup.locator('#enabledToggle').isChecked();
    if (!isChecked) {
      await popup.locator('#enabledToggle').evaluate((el: HTMLInputElement) => el.click());
      await popup.waitForTimeout(1000);
    }

    await popup.locator('#urlInput2').fill(`ws://127.0.0.1:${s.port}/ext`);
    await popup.waitForTimeout(1000);

    const code = await generateCode(s.baseUrl, s.token);
    const codeBoxes = popup.locator('#codeBoxes input');
    for (let i = 0; i < 6; i++) {
      await codeBoxes.nth(i).fill(code[i]);
      await popup.waitForTimeout(100);
    }

    await popup.waitForTimeout(500);
    await popup.locator('#pairBtn').click();

    try {
      await expect(popup.locator('#statusMain')).toContainText('Connected', { timeout: 30_000 });
    } catch {
      const debugPath = path.join(os.tmpdir(), 'bb-pair-debug.png');
      await popup.screenshot({ path: debugPath });
      const statusText = await popup.locator('#statusMain').textContent();
      const pairError = await popup.locator('#pairError').textContent();
      const sub = await popup.locator('#statusSub').textContent();
      throw new Error(`Pair failed. Status: "${statusText}", Sub: "${sub}", Error: "${pairError}". Screenshot at ${debugPath}`);
    }
    await popup.close();
  });

  test('execute eval through paired extension', async () => {
    const { status, body } = await apiCall(s.baseUrl, s.token, 'eval', { expression: '1+1' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBe(2);
  });

  test('tabs.list returns results', async () => {
    const { status, body } = await apiCall(s.baseUrl, s.token, 'tabs.list');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBeGreaterThan(0);
  });

  test('unpair from popup', async () => {
    const popup = await getExtensionPopup(context);
    const unpairBtn = popup.locator('#unpairBtn');
    if (await unpairBtn.isVisible()) {
      await unpairBtn.click();
      await popup.waitForTimeout(1000);
    }
    await popup.close();
  });
});

// ============================================================
// 6. CLI commands
// ============================================================

test.describe('CLI commands', () => {
  let s: ServerInstance;
  test.beforeAll(async () => { s = await startServer(); });
  test.afterAll(() => stopServer(s));

  test('info returns health JSON', async () => {
    const { stdout, code } = await runCli(['info', '--server', s.baseUrl, '--token', s.token]);
    expect(code).toBe(0);
    expect(stdout).toContain('"status"');
    expect(stdout).toContain('"ok"');
  });

  test('pair in local mode generates code', async () => {
    const { stdout, code } = await runCli(['pair', '--server', s.baseUrl, '--token', s.token]);
    expect(code).toBe(0);
    expect(stdout).toContain('Pairing code');
  });

  test('config set/get/reset', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-test-'));
    const env = stateEnv(stateDir);

    const set = await runCli(['config', 'set', 'server', 'http://test:9000'], env);
    expect(set.code).toBe(0);

    const get = await runCli(['config', 'get'], env);
    expect(get.stdout).toContain('http://test:9000');

    const reset = await runCli(['config', 'reset'], env);
    expect(reset.code).toBe(0);

    const getAfter = await runCli(['config', 'get'], env);
    expect(getAfter.stdout).toContain('No config set');

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('config get masks token', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-mask-'));
    const env = stateEnv(stateDir);
    await runCli(['config', 'set', 'token', 'abcdef12-3456-7890-abcd-ef1234567890'], env);
    const { stdout } = await runCli(['config', 'get'], env);
    expect(stdout).toContain('abcdef12...');
    expect(stdout).not.toContain('3456-7890');
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('config credentials stay in isolated test home', async () => {
    const testHome = makeTempStateEnv('bb-cli-credential-');
    const token = 'isolated-test-token';
    const configFile = path.join(testHome.stateDir, '.browser-bridge', 'config.json');
    const realConfigFile = path.join(os.homedir(), '.browser-bridge', 'config.json');

    try {
      const set = await runCli(['config', 'set', 'token', token], testHome.env);
      expect(set.code).toBe(0);
      expect(path.resolve(configFile)).not.toBe(path.resolve(realConfigFile));
      expect(fs.existsSync(configFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(configFile, 'utf-8')).token).toBe(token);
    } finally {
      testHome.cleanup();
    }
  });

  test('server start/status/stop lifecycle', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-server-'));
    const port = nextPort();
    const env = stateEnv(stateDir);

    try {
      const start = await runCli(['server', 'start', '--port', String(port), '--token', 'server-lifecycle-token'], env);
      expect(start.code).toBe(0);
      expect(start.stdout).toContain('Server started');

      const status = await runCli(['server', 'status'], env);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain('Server running');
      expect(status.stdout).toContain('Health: ok');

      const stop = await runCli(['server', 'stop'], env);
      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Server stopped');
    } finally {
      await runCli(['server', 'stop'], env).catch(() => undefined);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('install-service is guarded outside Linux', async () => {
    test.skip(process.platform === 'linux', 'install-service is intentionally Linux-only.');

    const { code, stderr } = await runCli(['server', 'install-service']);
    expect(code).toBe(1);
    expect(stderr).toContain('install-service is only supported on Linux');
  });
});

// ============================================================
// 7. End-to-end: server + extension + CLI
// ============================================================

test.describe('End-to-end flow', () => {
  let s: ServerInstance;
  let context: Awaited<ReturnType<typeof launchBrowserWithExtension>>;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    s = await startServer();
    context = await launchBrowserWithExtension(`ws://127.0.0.1:${s.port}/ext`);
    const popup = await getExtensionPopup(context);
    const toggle = popup.locator('#enabledToggle');
    if (!(await toggle.isChecked())) await toggle.evaluate((el: HTMLInputElement) => el.click());
    await popup.waitForTimeout(1000);
    const wsUrlInput = popup.locator('#urlInput2');
    await wsUrlInput.fill(`ws://127.0.0.1:${s.port}/ext`);
    await popup.waitForTimeout(1000);
    const code = await generateCode(s.baseUrl, s.token);
    const codeBoxes = popup.locator('#codeBoxes input');
    for (let i = 0; i < 6; i++) {
      await codeBoxes.nth(i).fill(code[i]);
      await popup.waitForTimeout(100);
    }
    await popup.waitForTimeout(500);
    await popup.locator('#pairBtn').click();
    await expect(popup.locator('#statusMain')).toContainText('Connected', { timeout: 30_000 });
    await popup.close();
  });

  test.afterAll(async () => {
    await context?.close();
    stopServer(s);
  });

  test('CLI tabs via server+extension returns tab list', async () => {
    const { stdout, code } = await runCli(['tabs', '--server', s.baseUrl, '--token', s.token]);
    expect(code).toBe(0);
    expect(stdout).toContain('[');
  });

  test('CLI eval "1+1" returns 2', async () => {
    const { stdout, code } = await runCli(['eval', '1+1', '--server', s.baseUrl, '--token', s.token]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('2');
  });

  test('CLI query and PDF use CDP paths', async () => {
    const page = await context.newPage();
    await page.setContent('<main><h1 id="fixture-title">CDP fixture</h1></main>');
    await page.bringToFront();
    const pdfFile = path.join(os.tmpdir(), `bb-test-page-${Date.now()}.pdf`);

    try {
      const query = await runCli(['query', '#fixture-title', '--server', s.baseUrl, '--token', s.token]);
      expect(query.code).toBe(0);
      expect(query.stdout).toContain('fixture-title');
      expect(query.stdout).toContain('CDP fixture');

      const pdf = await runCli(['pdf', '-o', pdfFile, '--server', s.baseUrl, '--token', s.token]);
      expect(pdf.code).toBe(0);
      expect(fs.existsSync(pdfFile)).toBe(true);
      expect(fs.readFileSync(pdfFile, 'utf-8').slice(0, 5)).toBe('%PDF-');
    } finally {
      await page.close();
      try { fs.unlinkSync(pdfFile); } catch {}
    }
  });

  test('raw CDP uploads paths, intercepts file choosers and drops files', async () => {
    const page = await context.newPage();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-upload-'));
    const file = path.join(dir, '上传 sample.txt');
    fs.writeFileSync(file, 'bridge upload content');
    await page.setContent(`<input id="file" type="file" multiple>
      <button id="choose" onclick="const input = document.createElement('input'); input.type='file'; input.id='dynamic'; document.body.append(input); input.click()">Choose</button>
      <div id="drop" style="position:absolute;left:0;top:100px;width:300px;height:200px"
        ondragover="event.preventDefault()"
        ondrop="event.preventDefault(); window.dropped = Promise.all([...event.dataTransfer.files].map(async f => ({name:f.name, text:await f.text()})))">Drop</div>
      <div draggable="true" style="position:absolute;left:0;top:320px;width:150px;height:100px"
        ondragstart="event.dataTransfer.setData('text/plain', 'page drag')">Drag me</div>
      <div style="position:absolute;left:320px;top:320px;width:200px;height:100px" ondragover="event.preventDefault()"
        ondrop="event.preventDefault(); window.dragText=event.dataTransfer.getData('text/plain')">Target</div>`);
    await page.bringToFront();
    const tabs = await apiCall(s.baseUrl, s.token, 'tabs.list');
    const tabId = (tabs.body.data as any[]).find(tab => tab.active && tab.url === 'about:blank').id;
    const cdp = async (method: string, params = {}) => {
      const result = await runCli(['cdp', method, JSON.stringify(params), '-t', String(tabId), '-k', '--server', s.baseUrl, '--token', s.token]);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };
    try {
      const root = await cdp('DOM.getDocument');
      const input = await cdp('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#file' });
      await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
      expect(await page.locator('#file').evaluate(async (el: HTMLInputElement) => await el.files![0].text())).toBe('bridge upload content');
      const capture = await runCli(['cdp-events', '-t', String(tabId), '--server', s.baseUrl, '--token', s.token]);
      expect(capture.code).toBe(0);
      const start = JSON.parse(capture.stdout);
      await cdp('Page.enable');
      await cdp('Page.setInterceptFileChooserDialog', { enabled: true });
      await cdp('Runtime.evaluate', { expression: "document.querySelector('#choose').click()", userGesture: true });
      let chooser: any;
      await expect.poll(async () => {
        const result = await runCli(['cdp-events', '-t', String(tabId), '--since', String(start.cursor), '--stream', start.streamId, '--method', 'Page.fileChooserOpened', '--server', s.baseUrl, '--token', s.token]);
        expect(result.code).toBe(0);
        chooser = JSON.parse(result.stdout).events[0];
        return chooser?.method;
      }).toBe('Page.fileChooserOpened');
      await cdp('DOM.setFileInputFiles', { backendNodeId: chooser.params.backendNodeId, files: [file] });
      expect(await page.locator('#dynamic').evaluate(async (el: HTMLInputElement) => await el.files![0].text())).toBe('bridge upload content');
      await cdp('Page.setInterceptFileChooserDialog', { enabled: false });

      const data = { items: [], files: [file], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp('Input.dispatchDragEvent', { type, x: 100, y: 150, data });
      }
      expect(await page.evaluate(() => (window as any).dropped)).toEqual([{ name: '上传 sample.txt', text: 'bridge upload content' }]);

      await cdp('Input.setInterceptDrags', { enabled: true });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 350 });
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 350, button: 'left', buttons: 1, clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 350, button: 'left', buttons: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 350, y: 350, button: 'left', buttons: 1 });
      let drag: any;
      await expect.poll(async () => {
        const result = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, method: 'Input.dragIntercepted' });
        drag = (result.body.data as any).events[0];
        return !!drag;
      }).toBe(true);
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp('Input.dispatchDragEvent', { type, x: 350, y: 350, data: drag.params.data });
      }
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 350, y: 350, button: 'left', buttons: 0, clickCount: 1 });
      await cdp('Input.setInterceptDrags', { enabled: false });
      expect(await page.evaluate(() => (window as any).dragText)).toBe('page drag');

      const replay = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, since: start.cursor, streamId: start.streamId, method: 'Page.fileChooserOpened' });
      expect((replay.body.data as any).events[0]).toEqual(chooser);
      const next = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, since: (replay.body.data as any).cursor, streamId: start.streamId, method: 'Page.fileChooserOpened' });
      expect((next.body.data as any).events).toEqual([]);
      await apiCall(s.baseUrl, s.token, 'cdp.detach', { tabId });
      await expect.poll(async () => {
        const read = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, streamId: start.streamId });
        return (read.body.data as any).attached;
      }).toBe(false);
      await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, stop: true });
      const stale = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, streamId: start.streamId });
      expect(stale.body.success).toBe(false);
    } finally {
      await apiCall(s.baseUrl, s.token, 'cdp.detach', { tabId });
      await page.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('raw CDP routes iframe sessions and their file chooser events', async () => {
    await context.route('http://bridge-*.test/**', route => route.fulfill({
      contentType: 'text/html', body: '<input type="file" id="file">',
    }));
    const page = await context.newPage();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-frame-upload-'));
    const file = path.join(dir, 'frame.txt');
    fs.writeFileSync(file, 'iframe upload');
    let tabId: number;
    try {
      await page.goto('http://bridge-parent.test/');
      const tabs = await apiCall(s.baseUrl, s.token, 'tabs.list');
      tabId = (tabs.body.data as any[]).find(tab => tab.url === page.url()).id;
      const cdp = async (method: string, params = {}, sessionId?: string) => {
        const result = await apiCall(s.baseUrl, s.token, 'cdp', { tabId, method, params, sessionId, keepAttached: true });
        expect(result.body.success, JSON.stringify(result.body)).toBe(true);
        return result.body.data as any;
      };
      const capture = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId });
      const start = capture.body.data as any;
      await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await cdp('Runtime.evaluate', { expression: "const frame = document.createElement('iframe'); frame.src='http://bridge-child.test/'; document.body.append(frame)" });
      let sessionId: string;
      await expect.poll(async () => {
        const events = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, since: start.cursor, method: 'Target.attachedToTarget' });
        sessionId = (events.body.data as any).events.find((event: any) => event.params.targetInfo.type === 'iframe')?.params.sessionId;
        return !!sessionId;
      }).toBe(true);
      const routed = await runCli(['cdp', 'Runtime.evaluate', JSON.stringify({ expression: 'location.hostname', returnByValue: true }), '-t', String(tabId), '-k', '--session', sessionId!, '--server', s.baseUrl, '--token', s.token]);
      expect(routed.code, routed.stderr).toBe(0);
      expect(JSON.parse(routed.stdout).result.value).toBe('bridge-child.test');
      await cdp('Page.enable', {}, sessionId!);
      await cdp('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId!);
      await cdp('Runtime.evaluate', { expression: "document.querySelector('#file').click()", userGesture: true }, sessionId!);
      let chooser: any;
      await expect.poll(async () => {
        const events = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, method: 'Page.fileChooserOpened', sessionId });
        chooser = (events.body.data as any).events[0];
        return chooser?.sessionId;
      }).toBe(sessionId!);
      await cdp('DOM.setFileInputFiles', { backendNodeId: chooser.params.backendNodeId, files: [file] }, sessionId!);
      const content = await cdp('Runtime.evaluate', { expression: "document.querySelector('#file').files[0].text()", awaitPromise: true, returnByValue: true }, sessionId!);
      expect(content.result.value).toBe('iframe upload');
      const invalid = await apiCall(s.baseUrl, s.token, 'cdp', { tabId, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'invalid', keepAttached: true });
      expect(invalid.body.success).toBe(false);
    } finally {
      await page.close();
      await context.unroute('http://bridge-*.test/**');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('raw CDP event capture reports overflow and session replacement', async () => {
    const page = await context.newPage();
    await page.bringToFront();
    const tabs = await apiCall(s.baseUrl, s.token, 'tabs.list');
    const tabId = (tabs.body.data as any[]).find(tab => tab.active && tab.url === 'about:blank').id;
    try {
      const capture = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId });
      const start = capture.body.data as any;
      const log = await apiCall(s.baseUrl, s.token, 'cdp', {
        tabId, keepAttached: true, method: 'Runtime.evaluate', params: { expression: 'for (let i=0;i<510;i++) console.log(i)' },
      });
      expect(log.body.success, JSON.stringify(log.body)).toBe(true);
      let read: any;
      await expect.poll(async () => {
        const result = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, streamId: start.streamId, since: start.cursor });
        read = result.body.data;
        return read.dropped;
      }).toBe(true);
      expect(read.events.length).toBeLessThanOrEqual(500);
      const oversized = await apiCall(s.baseUrl, s.token, 'cdp', {
        tabId, keepAttached: true, method: 'Runtime.evaluate', params: { expression: "console.log('x'.repeat(2100000))" },
      });
      expect(oversized.body.success).toBe(true);
      await expect.poll(async () => {
        const result = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, since: read.cursor });
        return (result.body.data as any).dropped;
      }).toBe(true);
      await apiCall(s.baseUrl, s.token, 'cdp.detach', { tabId });
      await expect.poll(async () => {
        const result = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId });
        return (result.body.data as any).detached !== null;
      }).toBe(true);
      await apiCall(s.baseUrl, s.token, 'cdp', { tabId, keepAttached: true, method: 'Runtime.enable' });
      const stale = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId, streamId: start.streamId });
      expect(stale.body.success).toBe(false);
      const fresh = await apiCall(s.baseUrl, s.token, 'cdp.events', { tabId });
      expect((fresh.body.data as any).streamId).not.toBe(start.streamId);
      const negative = await runCli(['cdp-events', '-t', String(tabId), '--since', '-1', '--server', s.baseUrl, '--token', s.token]);
      expect(negative.code).not.toBe(0);
      expect(negative.stderr).toContain('Invalid event cursor');
    } finally {
      await page.close();
    }
  });

  test('CLI screenshot saves file', async () => {
    const tmpFile = path.join(os.tmpdir(), `bb-test-screenshot-${Date.now()}.png`);
    const { code } = await runCli(['screenshot', '-o', tmpFile, '--server', s.baseUrl, '--token', s.token]);
    expect(code).toBe(0);
    expect(fs.existsSync(tmpFile)).toBe(true);
    expect(fs.statSync(tmpFile).size).toBeGreaterThan(100);
    fs.unlinkSync(tmpFile);
  });

  test('CLI full and custom-height screenshots save expected image heights', async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(`
      <style>
        body { margin: 0; font-family: sans-serif; }
        main { position: relative; width: 800px; height: 2400px; background: #ffffff; }
        .fixed { position: fixed; top: 0; left: 0; width: 800px; height: 40px; background: rgb(0, 0, 255); z-index: 10; }
        .clamped { position: absolute; top: 1800px; left: 0; width: 800px; height: 100px; background: rgb(255, 0, 0); }
        .target { position: absolute; top: 2200px; left: 0; width: 800px; height: 100px; background: rgb(0, 255, 0); }
      </style>
      <div class="fixed"></div>
      <main>
        <div class="clamped"></div>
        <div class="target"></div>
      </main>
    `);
    await page.bringToFront();

    const fullFile = path.join(os.tmpdir(), `bb-test-full-screenshot-${Date.now()}.png`);
    const clipFile = path.join(os.tmpdir(), `bb-test-clip-screenshot-${Date.now()}.png`);
    const longFile = path.join(os.tmpdir(), `bb-test-long-screenshot-${Date.now()}.png`);
    const longClipFile = path.join(os.tmpdir(), `bb-test-long-clip-screenshot-${Date.now()}.png`);

    try {
      const clip = await runCli(['screenshot', '--height', '1200', '-o', clipFile, '--server', s.baseUrl, '--token', s.token]);
      expect(clip.code).toBe(0);
      expect(readPngSize(clipFile).height).toBe(1200);

      const bottomClip = await runCli([
        'screenshot',
        '--y', '2200',
        '--height', '100',
        '-o', clipFile,
        '--server', s.baseUrl,
        '--token', s.token,
      ]);
      expect(bottomClip.code).toBe(0);
      expect(readPngSize(clipFile).height).toBe(100);

      const full = await runCli(['screenshot', '--full', '-o', fullFile, '--server', s.baseUrl, '--token', s.token]);
      expect(full.code).toBe(0);
      expect(readPngSize(fullFile).height).toBeGreaterThanOrEqual(2400);

      const long = await runCli(['screenshot', '--long', '-o', longFile, '--server', s.baseUrl, '--token', s.token]);
      expect(long.code).toBe(0);
      expect(readPngSize(longFile).height).toBeGreaterThanOrEqual(2400);
      const [longR, longG, longB] = await readPngPixel(context, longFile, 10, 2210);
      expect(longG).toBeGreaterThan(240);
      expect(longR).toBeLessThan(20);
      expect(longB).toBeLessThan(20);
      const [repeatedR, repeatedG, repeatedB] = await readPngPixel(context, longFile, 10, 610);
      expect(repeatedR).toBeGreaterThan(240);
      expect(repeatedG).toBeGreaterThan(240);
      expect(repeatedB).toBeGreaterThan(240);

      const longHeightClip = await runCli([
        'screenshot',
        '--long',
        '--height', '700',
        '-o', longClipFile,
        '--server', s.baseUrl,
        '--token', s.token,
      ]);
      expect(longHeightClip.code).toBe(0);
      expect(readPngSize(longClipFile).height).toBe(700);

      const longBottomClip = await runCli([
        'screenshot',
        '--long',
        '--y', '2200',
        '--height', '100',
        '-o', longClipFile,
        '--server', s.baseUrl,
        '--token', s.token,
      ]);
      expect(longBottomClip.code).toBe(0);
      expect(readPngSize(longClipFile).height).toBe(100);
      const [bottomLongR, bottomLongG, bottomLongB] = await readPngPixel(context, longClipFile, 10, 10);
      expect(bottomLongG).toBeGreaterThan(240);
      expect(bottomLongR).toBeLessThan(20);
      expect(bottomLongB).toBeLessThan(20);

      const limitedLong = await runCli([
        'screenshot',
        '--long',
        '--max-height', '1200',
        '-o', longFile,
        '--server', s.baseUrl,
        '--token', s.token,
      ]);
      expect(limitedLong.code).toBe(0);
      expect(limitedLong.stderr).toContain('Long screenshot limited to 1200px');
      expect(readPngSize(longFile).height).toBe(1200);

      const [r, g, b] = await readPngPixel(context, clipFile, 10, 50);
      expect(g).toBeGreaterThan(240);
      expect(r).toBeLessThan(20);
      expect(b).toBeLessThan(20);
    } finally {
      await page.close();
      try { fs.unlinkSync(fullFile); } catch {}
      try { fs.unlinkSync(clipFile); } catch {}
      try { fs.unlinkSync(longFile); } catch {}
      try { fs.unlinkSync(longClipFile); } catch {}
    }
  });

  test('CLI long screenshot keeps sticky content unless configured', async () => {
    const page = await context.newPage();
    const hidePage = await context.newPage();
    const setStickyPage = async (targetPage: typeof page, pageTitle: string) => {
      await targetPage.setViewportSize({ width: 800, height: 600 });
      await targetPage.setContent(`
      <title>${pageTitle}</title>
      <style>
        body { margin: 0; font-family: sans-serif; background: #ffffff; }
        .spacer { height: 650px; }
        .sticky { position: sticky; top: 0; width: 800px; height: 60px; background: rgb(255, 0, 255); }
        .tail { height: 1000px; }
      </style>
      <div class="spacer"></div>
      <div class="sticky"></div>
      <div class="tail"></div>
    `);
      await targetPage.bringToFront();
      await targetPage.waitForTimeout(200);
      const { body } = await apiCall(s.baseUrl, s.token, 'tabs.list');
      const tabs = body.data as Array<{ id: number; title?: string }>;
      const tabId = tabs.find((tab) => tab.title === pageTitle)?.id;
      expect(tabId).toBeTruthy();
      return tabId;
    };
    const defaultLongFile = path.join(os.tmpdir(), `bb-test-sticky-long-${Date.now()}.png`);
    const hideStickyLongFile = path.join(os.tmpdir(), `bb-test-sticky-hide-long-${Date.now()}.png`);

    try {
      const tabId = await setStickyPage(page, `sticky-test-${Date.now()}`);
      const long = await runCli([
        'screenshot',
        '--long',
        '-t', String(tabId),
        '-o', defaultLongFile,
        '--server', s.baseUrl,
        '--token', s.token,
      ]);
      expect(long.code).toBe(0);

      const hideStickyTabId = await setStickyPage(hidePage, `sticky-hide-test-${Date.now()}`);
      const hideStickyLong = await runCli([
        'screenshot',
        '--long',
        '--hide-sticky',
        '-t', String(hideStickyTabId),
        '-o', hideStickyLongFile,
        '--server', s.baseUrl,
        '--token', s.token,
      ]);
      expect(hideStickyLong.code).toBe(0);

      const [stickyR, stickyG, stickyB] = await readPngPixel(context, defaultLongFile, 10, 660);
      expect(stickyR).toBeGreaterThan(240);
      expect(stickyG).toBeLessThan(20);
      expect(stickyB).toBeGreaterThan(240);

      const [hiddenStickyR, hiddenStickyG, hiddenStickyB] = await readPngPixel(context, hideStickyLongFile, 10, 660);
      expect(hiddenStickyR).toBeGreaterThan(240);
      expect(hiddenStickyG).toBeGreaterThan(240);
      expect(hiddenStickyB).toBeGreaterThan(240);
    } finally {
      await page.close();
      await hidePage.close();
      try { fs.unlinkSync(defaultLongFile); } catch {}
      try { fs.unlinkSync(hideStickyLongFile); } catch {}
    }
  });
});
