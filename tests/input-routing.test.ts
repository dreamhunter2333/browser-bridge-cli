import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { startServer, stopServer, generateCode, apiCall, runCli, type ServerInstance } from './helpers';

async function connectBrowser(server: ServerInstance, name: string, onCommand: (message: any, ws: WebSocket) => Promise<unknown>) {
  const code = await generateCode(server.baseUrl, server.token);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ext`, { origin: `chrome-extension://${name}` });
  const id = await new Promise<string>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'pair', code, name })));
    ws.on('message', async data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'pair') {
        if (!message.success) { reject(new Error(message.error)); return; }
        resolve(message.clientId);
        return;
      }
      const result = await onCommand(message, ws);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, success: true, data: result }));
    });
  });
  return { id, ws };
}

for (const scenario of [
  { name: 'tab lookup', args: ['click', '#target'], trigger: 'tabs.current', types: ['mouseMoved', 'mousePressed', 'mouseReleased'] },
  { name: 'mouse move', args: ['click', '--x', '10', '--y', '20', '-t', '123'], trigger: 'mouseMoved', types: ['mouseMoved', 'mousePressed', 'mouseReleased'] },
  { name: 'key down', args: ['press', 'q', '--code', 'KeyQ', '--key-code', '81'], trigger: 'rawKeyDown', types: ['rawKeyDown', 'keyUp'] },
]) {
  test(`CLI input pins its browser when active client changes during ${scenario.name}`, async () => {
    const server = await startServer();
    const sockets: WebSocket[] = [];
    const routed: Array<{ name: string; action: string; type?: string }> = [];
    let otherId = '', switched = false;
    try {
      for (const name of ['a', 'b']) {
        const browser = await connectBrowser(server, name, async message => {
          const type = message.params?.params?.type;
          routed.push({ name, action: message.action, type });
          if (!switched && (type === scenario.trigger || message.action === scenario.trigger)) {
            switched = true;
            await apiCall(server.baseUrl, server.token, 'client.switch', { clientId: otherId });
          }
          if (message.action === 'tabs.current') return { id: 123 };
          if (message.params?.method === 'Runtime.evaluate') return { result: { value: { x: 10, y: 20 } } };
          return {};
        });
        sockets.push(browser.ws);
        if (name === 'b') otherId = browser.id;
      }
      const result = await runCli([...scenario.args, '--server', server.baseUrl, '--token', server.token]);
      expect(switched).toBe(true);
      expect(result.code, result.stderr).toBe(0);
      expect(routed.every(command => command.name === 'a')).toBe(true);
      expect(routed.map(command => command.type).filter(Boolean)).toEqual(scenario.types);
      expect(routed.at(-1)?.action).toBe('cdp.detach');
    } finally {
      for (const ws of sockets) ws.terminate();
      stopServer(server);
    }
  });
}

test('CLI input never releases or detaches on a different browser after disconnect', async () => {
  const server = await startServer();
  const sockets: WebSocket[] = [];
  const otherCommands: string[] = [];
  try {
    const source = await connectBrowser(server, 'a', async (message, ws) => {
      if (message.params?.params?.type === 'rawKeyDown') ws.terminate();
      return {};
    });
    sockets.push(source.ws);
    const other = await connectBrowser(server, 'b', async message => { otherCommands.push(message.action); return {}; });
    sockets.push(other.ws);
    const result = await runCli(['press', 'q', '--code', 'KeyQ', '--key-code', '81', '-t', '123', '--server', server.baseUrl, '--token', server.token]);
    expect(result.code).toBe(1);
    expect(otherCommands).toEqual([]);
    const clients = await apiCall(server.baseUrl, server.token, 'client.list');
    expect((clients.body.data as any[]).find(client => client.active)?.id).toBe(other.id);
  } finally {
    for (const ws of sockets) ws.terminate();
    stopServer(server);
  }
});

test('CLI equivalent explicit zero deltas never trigger default vertical scrolling', async () => {
  const server = await startServer();
  let browser: Awaited<ReturnType<typeof connectBrowser>> | undefined;
  let wheel: any;
  try {
    browser = await connectBrowser(server, 'a', async message => {
      if (message.params?.params?.type === 'mouseWheel') wheel = message.params.params;
      return {};
    });
    for (const value of ['0', '0.0', '00', '-0']) {
      wheel = undefined;
      const result = await runCli(['scroll', '--delta-x', value, '--x', '10', '--y', '20', '-t', '123', '--server', server.baseUrl, '--token', server.token]);
      expect(result.code, result.stderr).toBe(0);
      expect(wheel).toMatchObject({ deltaX: 0, deltaY: 0 });
    }
  } finally {
    browser?.ws.terminate();
    stopServer(server);
  }
});

test('CLI group creation keeps metadata and membership requests on the original browser', async () => {
  const server = await startServer();
  const sockets: WebSocket[] = [];
  const routed: string[] = [];
  let otherId = '';
  const group = { id: 777, windowId: 1, title: '', color: 'grey', collapsed: false };
  try {
    for (const name of ['a', 'b']) {
      const browser = await connectBrowser(server, name, async message => {
        routed.push(name);
        if (message.action === 'tabs.group') {
          await apiCall(server.baseUrl, server.token, 'client.switch', { clientId: otherId });
          return group.id;
        }
        if (message.action === 'groups.update') Object.assign(group, message.params.properties);
        if (message.action === 'tabs.list') return [{ id: 123, groupId: group.id, index: 0 }];
        return group;
      });
      sockets.push(browser.ws);
      if (name === 'b') otherId = browser.id;
    }
    const result = await runCli(['groups', 'create', '123', '--title', 'work', '--color', 'blue', '--server', server.baseUrl, '--token', server.token]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 777, title: 'work', color: 'blue', tabIds: [123] });
    expect(routed).toEqual(['a', 'a', 'a', 'a']);
  } finally {
    for (const ws of sockets) ws.terminate();
    stopServer(server);
  }
});
