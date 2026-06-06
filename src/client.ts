import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export const STATE_DIR = path.join(os.homedir(), '.browser-bridge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

export type Config = {
  server?: string;
  token?: string;
  name?: string;
};

export function loadConfigFile(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(partial: Partial<Config>) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const existing = loadConfigFile();
  const merged = { ...existing, ...partial };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) delete (merged as Record<string, unknown>)[k];
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

export function resetConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 52853;

function readState(): { token: string; host: string; port: number } {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return { token: state.serverToken || state.pairingToken, host: state.host || DEFAULT_HOST, port: state.port || DEFAULT_PORT };
  } catch {
    try {
      const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      return { token, host: DEFAULT_HOST, port: DEFAULT_PORT };
    } catch {
      return { token: '', host: DEFAULT_HOST, port: DEFAULT_PORT };
    }
  }
}

export function isLocalServer(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

export type ResolvedConfig = { url: string; token: string; isLocal: boolean };

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveConfig(opts?: { server?: string; token?: string }): ResolvedConfig {
  const fileConfig = loadConfigFile();

  const rawUrl = opts?.server
    || process.env.BROWSER_BRIDGE_URL
    || fileConfig.server
    || undefined;

  const token = opts?.token
    || process.env.BROWSER_BRIDGE_TOKEN
    || fileConfig.token
    || undefined;

  if (rawUrl) {
    const url = normalizeUrl(rawUrl);
    const local = isLocalServer(url);
    if (local && !token) {
      try {
        const state = readState();
        return { url, token: state.token, isLocal: true };
      } catch {
        return { url, token: '', isLocal: true };
      }
    }
    if (!local && !token) {
      throw new Error(`Not authenticated for remote server ${url}.\nRun: browser-bridge-cli pair --server ${url}`);
    }
    return { url, token: token || '', isLocal: local };
  }

  const state = readState();
  return {
    url: `http://${state.host}:${state.port}`,
    token: token || state.token,
    isLocal: true,
  };
}

let _globalOpts: { server?: string; token?: string } | undefined;

export function setGlobalOpts(opts: { server?: string; token?: string }) {
  _globalOpts = opts;
}

export function getBridgeUrl(): string {
  return resolveConfig(_globalOpts).url;
}

export async function ensureServer(): Promise<void> {
  const config = resolveConfig(_globalOpts);
  if (!config.isLocal) {
    if (await health()) return;
    throw new Error(`Cannot reach remote server ${config.url}`);
  }

  if (await health()) return;

  const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.js');
  const spawnArgs = [serverPath];
  try {
    const u = new URL(config.url);
    if (u.hostname && u.hostname !== '127.0.0.1') spawnArgs.push('--host', u.hostname);
    if (u.port) spawnArgs.push('--port', u.port);
  } catch {}

  const child = spawn('node', spawnArgs, {
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
  const config = resolveConfig(_globalOpts);
  const res = await fetch(`${config.url}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Browser-Bridge': config.token },
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
    const config = resolveConfig(_globalOpts);
    const res = await fetch(`${config.url}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function pairWithServer(serverUrl: string, code: string, name?: string): Promise<{ token: string; name: string }> {
  const url = normalizeUrl(serverUrl);
  const res = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Pairing failed');
  }
  return { token: json.token, name: json.name };
}
