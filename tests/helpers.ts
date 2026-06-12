import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'src', 'server.ts');
const CLI_PATH = path.join(PROJECT_ROOT, 'src', 'cli.ts');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'extension');

export type ServerInstance = {
  proc: ChildProcess;
  baseUrl: string;
  token: string;
  port: number;
  stateDir: string;
};

let portCounter = 19100;

export function nextPort(): number {
  return portCounter++;
}

export function stateEnv(stateDir: string): Record<string, string> {
  if (process.platform !== 'win32') return { HOME: stateDir };

  const root = path.parse(stateDir).root;
  return {
    HOME: stateDir,
    USERPROFILE: stateDir,
    HOMEDRIVE: root.slice(0, 2),
    HOMEPATH: stateDir.slice(2) || '\\',
  };
}

export function makeTempStateEnv(prefix = 'bb-cli-home-'): { env: Record<string, string>; stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    env: stateEnv(stateDir),
    stateDir,
    cleanup: () => {
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
    },
  };
}

export async function startServer(opts?: { token?: string; port?: number }): Promise<ServerInstance> {
  const port = opts?.port || nextPort();
  const token = opts?.token || `test-server-token-${port}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-test-'));

  const proc = spawn('bun', ['run', SERVER_PATH, '--host', '127.0.0.1', '--port', String(port), '--token', token], {
    env: { ...process.env, ...stateEnv(stateDir) },
    stdio: 'pipe',
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return { proc, baseUrl, token, port, stateDir };
    } catch {}
  }
  proc.kill();
  throw new Error(`Server failed to start on port ${port}`);
}

export function stopServer(s: ServerInstance) {
  try { s.proc.kill('SIGTERM'); } catch {}
  try { fs.rmSync(s.stateDir, { recursive: true, force: true }); } catch {}
}

export async function apiCall(baseUrl: string, token: string, action: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Browser-Bridge': token },
    body: JSON.stringify({ action, params }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

export async function httpPair(baseUrl: string, code: string, name?: string) {
  const res = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

export async function generateCode(baseUrl: string, token: string): Promise<string> {
  const { body } = await apiCall(baseUrl, token, 'pair.request');
  return (body.data as { code: string }).code;
}

export async function launchBrowserWithExtension(wsUrl: string): Promise<BrowserContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-chrome-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-gpu',
    ],
  });
  const close = context.close.bind(context);
  context.close = async (...args: Parameters<BrowserContext['close']>) => {
    try {
      await close(...args);
    } finally {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }
  };
  return context;
}

export async function getExtensionPopup(context: BrowserContext) {
  let extensionId = '';
  for (let retry = 0; retry < 10; retry++) {
    for (const sw of context.serviceWorkers()) {
      const url = sw.url();
      if (url.startsWith('chrome-extension://')) {
        extensionId = url.split('/')[2];
        break;
      }
    }
    if (extensionId) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!extensionId) throw new Error('Extension service worker not found after 10s');
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const page = await context.newPage();
  await page.goto(popupUrl);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

export function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const temp = env ? undefined : makeTempStateEnv();
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', CLI_PATH, ...args], {
      env: { ...process.env, ...(env || temp?.env) },
      stdio: 'pipe',
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      temp?.cleanup();
      resolve({ stdout, stderr, code: code || 0 });
    });
  });
}
