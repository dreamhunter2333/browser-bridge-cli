import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.browser-bridge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TOKEN_FILE = path.join(STATE_DIR, 'token');

function readState(): { token: string; host: string; port: number } {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return { token: state.serverToken || state.pairingToken, host: state.host || '127.0.0.1', port: state.port || 52853 };
  } catch {
    // Fallback to token-only file
    try {
      const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      return { token, host: '127.0.0.1', port: 52853 };
    } catch {
      throw new Error(`No state found at ${STATE_DIR}. Start bridge server first.`);
    }
  }
}

export function getBridgeUrl(): string {
  const { host, port } = readState();
  return `http://${host}:${port}`;
}

function detectRuntime(): { cmd: string; args: string[] } {
  try {
    if (typeof Bun !== 'undefined') return { cmd: 'bun', args: ['run'] };
  } catch {}
  return { cmd: 'npx', args: ['tsx'] };
}

export async function ensureServer(): Promise<void> {
  if (await health()) return;

  const serverPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'bridge', 'src', 'server.ts'
  );

  const rt = detectRuntime();
  const child = spawn(rt.cmd, [...rt.args, serverPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await health()) return;
  }
  throw new Error('Failed to start bridge server');
}

export async function request(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  await ensureServer();
  const { token } = readState();
  const url = getBridgeUrl();
  const res = await fetch(`${url}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Browser-Bridge': token },
    body: JSON.stringify({ action, params }),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Unknown error');
  }
  return json.data;
}

export async function health(): Promise<boolean> {
  try {
    const url = getBridgeUrl();
    const res = await fetch(`${url}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
