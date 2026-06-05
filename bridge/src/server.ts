import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';

// --- CLI args ---

const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '52853' },
    token: { type: 'string' },
    'gen-pair': { type: 'boolean', default: false },
  },
  strict: false,
});

const HOST = args.host!;
const PORT = parseInt(args.port!, 10);

// --- State dir (~/.browser-bridge/) ---

const stateDir = path.join(os.homedir(), '.browser-bridge');
fs.mkdirSync(stateDir, { recursive: true });

// --- gen-pair mode: request a pairing code from a running server ---

if (args['gen-pair']) {
  const stateFile = path.join(stateDir, 'state.json');
  let host = '127.0.0.1', port = 52853, token = '';
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    host = saved.host || host;
    port = saved.port || port;
    token = saved.serverToken || '';
  } catch {
    console.error('No running server found. Start the server first.');
    process.exit(1);
  }
  try {
    const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Browser-Bridge': token },
      body: JSON.stringify({ action: 'pair.request' }),
    });
    const json = await res.json() as { success: boolean; data?: { code: string }; error?: string };
    if (!json.success) throw new Error(json.error || 'Failed');
    console.log(`\n  Pairing code: ${json.data!.code}\n`);
    console.log('Enter this code in the CLI or extension to pair.');
    console.log('Code expires in 5 minutes.');
  } catch (e) {
    console.error(`Failed to generate pairing code: ${e}`);
    process.exit(1);
  }
  process.exit(0);
}

// --- Pairing ---

type PairingRequest = { code: string; expiresAt: number };
const pendingPairings = new Map<string, PairingRequest>();
const PAIRING_TTL = 300_000; // 5 min

// Server master token for CLI auth (not tied to any client)
const stateFile = path.join(stateDir, 'state.json');
let serverToken: string;

if (args.token) {
  serverToken = args.token;
} else {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    serverToken = saved.serverToken || randomUUID();
  } catch {
    serverToken = randomUUID();
  }
}

// Client tokens: clientName -> token
const tokensFile = path.join(stateDir, 'tokens.json');
const clientTokens = new Map<string, string>();

try {
  const saved = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
  for (const [name, token] of Object.entries(saved)) {
    clientTokens.set(name, token as string);
  }
} catch {}

function saveTokens() {
  fs.writeFileSync(tokensFile, JSON.stringify(Object.fromEntries(clientTokens), null, 2));
}

function createPairingCode(): string {
  const code = String(randomInt(100000, 999999));
  for (const [k, v] of pendingPairings) {
    if (v.expiresAt < Date.now()) pendingPairings.delete(k);
  }
  const id = randomUUID().slice(0, 8);
  pendingPairings.set(id, { code, expiresAt: Date.now() + PAIRING_TTL });
  return code;
}

function validatePairingCode(code: string): boolean {
  for (const [id, req] of pendingPairings) {
    if (req.code === code && req.expiresAt > Date.now()) {
      pendingPairings.delete(id);
      return true;
    }
  }
  return false;
}

// Write state
fs.writeFileSync(stateFile, JSON.stringify({ serverToken, host: HOST, port: PORT }, null, 2));
fs.writeFileSync(path.join(stateDir, 'token'), serverToken);

// --- Multi-client ---

type Client = {
  ws: WebSocket;
  id: string;
  name: string;
  token: string;
  paired: boolean;
  heartbeat: ReturnType<typeof setInterval>;
};

const clients = new Map<string, Client>();
let activeClientId: string | null = null;

function getReadyClient(id?: string): Client | null {
  const targetId = id || activeClientId;
  if (!targetId) return null;
  const c = clients.get(targetId);
  if (c && c.ws.readyState === WebSocket.OPEN && c.paired) return c;
  return null;
}

function findBestActiveClient(): string | null {
  return Array.from(clients.values()).find(c => c.paired && c.ws.readyState === WebSocket.OPEN)?.id || null;
}

const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const REQUEST_TIMEOUT = 30_000;
const HEARTBEAT_INTERVAL = 15_000;

process.on('uncaughtException', (err) => {
  console.error(`[bridge] uncaught:`, err);
});

// --- HTTP Server ---

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// --- Rate limiting for /api/pair ---

const pairAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_PAIR_ATTEMPTS = 5;
const PAIR_RATE_WINDOW = 60_000;

function checkPairRateLimit(ip: string): boolean {
  const now = Date.now();
  for (const [k, v] of pairAttempts) {
    if (now >= v.resetAt) pairAttempts.delete(k);
  }
  const entry = pairAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= MAX_PAIR_ATTEMPTS) return false;
    entry.count++;
    return true;
  }
  pairAttempts.set(ip, { count: 1, resetAt: now + PAIR_RATE_WINDOW });
  return true;
}

function authenticateRequest(req: http.IncomingMessage): boolean {
  const token = req.headers['x-browser-bridge'] as string;
  if (!token) return false;
  if (token === serverToken) return true;
  for (const t of clientTokens.values()) {
    if (t === token) return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Browser-Bridge',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    const base = { status: 'ok', host: HOST, port: PORT };
    if (authenticateRequest(req)) {
      const clientList = Array.from(clients.values()).map(c => ({
        id: c.id,
        name: c.name,
        paired: c.paired,
        active: c.id === activeClientId,
      }));
      sendJson(res, 200, { ...base, clients: clientList, activeClient: activeClientId });
    } else {
      sendJson(res, 200, base);
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/clients') {
    if (!authenticateRequest(req)) {
      sendJson(res, 403, { success: false, error: 'Invalid or missing token' });
      return;
    }
    const clientList = Array.from(clients.values()).map(c => ({
      id: c.id,
      name: c.name,
      paired: c.paired,
      active: c.id === activeClientId,
    }));
    sendJson(res, 200, { clients: clientList });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/pair') {
    const clientIp = req.socket.remoteAddress || '';
    if (!checkPairRateLimit(clientIp)) {
      sendJson(res, 429, { success: false, error: 'Too many attempts. Try again later.' });
      return;
    }
    try {
      const raw = await parseBody(req);
      const { code, name } = JSON.parse(raw);
      if (!code) {
        sendJson(res, 400, { success: false, error: 'Missing code' });
        return;
      }
      const clientName = name || `cli-${randomUUID().slice(0, 6)}`;
      if (clientTokens.has(clientName)) {
        sendJson(res, 409, { success: false, error: `Name "${clientName}" already taken` });
        return;
      }
      if (!validatePairingCode(code)) {
        sendJson(res, 403, { success: false, error: 'Invalid or expired pairing code' });
        return;
      }
      const clientToken = randomUUID();
      clientTokens.set(clientName, clientToken);
      saveTokens();
      console.log(`CLI client "${clientName}" paired via HTTP`);
      sendJson(res, 200, { success: true, token: clientToken, name: clientName });
    } catch (err) {
      sendJson(res, 500, { success: false, error: String(err) });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/execute') {
    if (!authenticateRequest(req)) {
      sendJson(res, 403, { success: false, error: 'Invalid or missing token' });
      return;
    }
    try {
      const raw = await parseBody(req);
      const { action, params, clientId } = JSON.parse(raw);
      if (!action) {
        sendJson(res, 400, { success: false, error: 'Missing action' });
        return;
      }

      // Generate pairing code
      if (action === 'pair.request') {
        const reqToken = req.headers['x-browser-bridge'] as string;
        if (reqToken !== serverToken) {
          sendJson(res, 403, { success: false, error: 'Only server token can generate pairing codes' });
          return;
        }
        const code = createPairingCode();
        console.log(`\n  New pairing code: ${code}\n`);
        sendJson(res, 200, { success: true, data: { code } });
        return;
      }

      if (action === 'token.revoke') {
        const reqToken = req.headers['x-browser-bridge'] as string;
        const name = params?.name as string;
        if (!name) {
          sendJson(res, 400, { success: false, error: 'Missing name' });
          return;
        }
        const isSelf = clientTokens.get(name) === reqToken;
        if (reqToken !== serverToken && !isSelf) {
          sendJson(res, 403, { success: false, error: 'Can only revoke own token or use server token' });
          return;
        }
        clientTokens.delete(name);
        saveTokens();
        for (const [, c] of clients) {
          if (c.name === name && c.paired) {
            c.paired = false;
            try { c.ws.send(JSON.stringify({ type: 'auth', success: false, error: 'Token revoked' })); } catch {}
            c.ws.close(4003, 'Token revoked');
          }
        }
        if (activeClientId) {
          const active = clients.get(activeClientId);
          if (!active || !active.paired || active.ws.readyState !== WebSocket.OPEN) {
            activeClientId = findBestActiveClient();
          }
        }
        console.log(`Token revoked for "${name}"`);
        sendJson(res, 200, { success: true, data: { revoked: name } });
        return;
      }

      // Switch active client
      if (action === 'client.switch') {
        if (params?.clientId && clients.has(params.clientId)) {
          activeClientId = params.clientId;
          sendJson(res, 200, { success: true, data: { activeClient: activeClientId } });
        } else {
          sendJson(res, 400, { success: false, error: 'Unknown client ID' });
        }
        return;
      }

      if (action === 'client.list') {
        const list = Array.from(clients.values()).map(c => ({
          id: c.id, name: c.name, paired: c.paired, active: c.id === activeClientId,
        }));
        sendJson(res, 200, { success: true, data: list });
        return;
      }

      // Route to specific client or active
      const target = getReadyClient(clientId);
      if (!target) {
        sendJson(res, 503, { success: false, error: 'No connected client' });
        return;
      }

      const result = await sendToClient(target, action, params || {});
      sendJson(res, 200, result as object);
    } catch (err) {
      sendJson(res, 500, { success: false, error: String(err) });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

// --- WebSocket Server ---

const wss = new WebSocketServer({ server, path: '/ext' });

function rejectPendingForClient(clientId: string, reason: string) {
  for (const [id, pending] of pendingRequests) {
    if (id.startsWith(clientId + ':')) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      pendingRequests.delete(id);
    }
  }
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (!origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')) {
    console.log(`Rejected connection from origin: ${origin}`);
    ws.close(4001, 'Invalid origin');
    return;
  }

  const clientId = randomUUID().slice(0, 8);
  const client: Client = {
    ws,
    id: clientId,
    name: origin.replace('chrome-extension://', '').replace('moz-extension://', '').slice(0, 16),
    token: '',
    paired: false,
    heartbeat: setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, HEARTBEAT_INTERVAL),
  };

  let wsPairFailCount = 0;
  const MAX_WS_PAIR_FAILURES = 5;

  clients.set(clientId, client);
  if (!activeClientId) activeClientId = clientId;

  console.log(`Client ${clientId} connected from ${origin}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'auth') {
        const name = msg.name || client.name;
        const savedToken = clientTokens.get(name);
        if (!savedToken || msg.token !== savedToken) {
          ws.send(JSON.stringify({ type: 'auth', success: false, needsPairing: true }));
          return;
        }
        const dup = Array.from(clients.values()).find(c => c.id !== clientId && c.name === name);
        if (dup) {
          ws.send(JSON.stringify({ type: 'auth', success: false, error: `Name "${name}" already taken` }));
          return;
        }
        client.paired = true;
        client.name = name;
        client.token = savedToken;
        if (!activeClientId || !clients.get(activeClientId)?.paired || clients.get(activeClientId)?.ws.readyState !== WebSocket.OPEN) activeClientId = clientId;
        console.log(`Client ${clientId} authenticated as "${client.name}"`);
        ws.send(JSON.stringify({ type: 'auth', success: true, clientId }));
        return;
      }

      if (msg.type === 'pair') {
        const failures = wsPairFailCount;
        if (failures >= MAX_WS_PAIR_FAILURES) {
          ws.send(JSON.stringify({ type: 'pair', success: false, error: 'Too many failed attempts' }));
          ws.close(4002, 'Rate limited');
          return;
        }
        const name = msg.name || client.name;
        const dup = Array.from(clients.values()).find(c => c.id !== clientId && c.name === name);
        if (dup || clientTokens.has(name)) {
          wsPairFailCount++;
          ws.send(JSON.stringify({ type: 'pair', success: false, error: `Name "${name}" already taken` }));
          return;
        }
        if (!validatePairingCode(msg.code)) {
          wsPairFailCount++;
          ws.send(JSON.stringify({ type: 'pair', success: false, error: 'Invalid or expired pairing code' }));
          return;
        }
        const clientToken = randomUUID();
        client.paired = true;
        client.name = name;
        client.token = clientToken;
        clientTokens.set(name, clientToken);
        saveTokens();
        if (!activeClientId || !clients.get(activeClientId)?.paired || clients.get(activeClientId)?.ws.readyState !== WebSocket.OPEN) activeClientId = clientId;
        console.log(`Client ${clientId} paired as "${client.name}"`);
        ws.send(JSON.stringify({ type: 'pair', success: true, token: clientToken, clientId }));
        return;
      }

      if (!client.paired) {
        ws.send(JSON.stringify({ id: msg.id, success: false, error: 'Not paired' }));
        return;
      }

      const pendingKey = clientId + ':' + msg.id;
      const pending = pendingRequests.get(pendingKey);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(pendingKey);
        pending.resolve(msg);
      }
    } catch (e) {
      console.warn('[bridge] malformed WS message:', e);
    }
  });

  ws.on('close', () => {
    console.log(`Client ${clientId} disconnected`);
    clearInterval(client.heartbeat);
    rejectPendingForClient(clientId, 'Client disconnected');
    clients.delete(clientId);
    if (activeClientId === clientId) {
      activeClientId = findBestActiveClient();
      if (activeClientId) console.log(`Active client switched to ${activeClientId}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`Client ${clientId} error: ${err}`);
  });
});

function sendToClient(client: Client, action: string, params: Record<string, unknown>): Promise<unknown> {
  const msgId = randomUUID();
  const pendingKey = client.id + ':' + msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(pendingKey);
      reject(new Error('Request timed out'));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(pendingKey, { resolve, reject, timer });
    try {
      client.ws.send(JSON.stringify({ id: msgId, action, params }));
    } catch (e) {
      pendingRequests.delete(pendingKey);
      clearTimeout(timer);
      reject(new Error(`Failed to send: ${e}`));
    }
  });
}

// --- Start ---

server.listen(PORT, HOST, () => {
  console.log(`Bridge listening on http://${HOST}:${PORT}`);
  console.log(`Extension WebSocket: ws://${HOST}:${PORT}/ext`);
  console.log(`Use "browser-bridge-cli pair" to generate pairing codes\n`);
});
