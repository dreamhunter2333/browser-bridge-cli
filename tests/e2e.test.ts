import { test, expect } from '@playwright/test';
import { startServer, stopServer, apiCall, httpPair, generateCode, launchBrowserWithExtension, getExtensionPopup, runCli, type ServerInstance } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
      await popup.screenshot({ path: '/tmp/bb-pair-debug.png' });
      const statusText = await popup.locator('#statusMain').textContent();
      const pairError = await popup.locator('#pairError').textContent();
      const sub = await popup.locator('#statusSub').textContent();
      throw new Error(`Pair failed. Status: "${statusText}", Sub: "${sub}", Error: "${pairError}". Screenshot at /tmp/bb-pair-debug.png`);
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
    const env = { HOME: stateDir };

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
    const env = { HOME: stateDir };
    await runCli(['config', 'set', 'token', 'abcdef12-3456-7890-abcd-ef1234567890'], env);
    const { stdout } = await runCli(['config', 'get'], env);
    expect(stdout).toContain('abcdef12...');
    expect(stdout).not.toContain('3456-7890');
    fs.rmSync(stateDir, { recursive: true, force: true });
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

  test('CLI screenshot saves file', async () => {
    const tmpFile = path.join(os.tmpdir(), `bb-test-screenshot-${Date.now()}.png`);
    const { code } = await runCli(['screenshot', '-o', tmpFile, '--server', s.baseUrl, '--token', s.token]);
    expect(code).toBe(0);
    expect(fs.existsSync(tmpFile)).toBe(true);
    expect(fs.statSync(tmpFile).size).toBeGreaterThan(100);
    fs.unlinkSync(tmpFile);
  });
});
