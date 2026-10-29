import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCli } from './helpers';

for (const input of [
  { args: ['click', '--x', '10', '--y', '20'], down: 'mousePressed', up: 'mouseReleased' },
  { args: ['press', 'a', '--code', 'KeyA', '--key-code', '65'], down: 'rawKeyDown', up: 'keyUp' },
]) {
  test(`CLI releases ${input.down} when its acknowledgement fails`, async () => {
    const events: string[] = [];
    let rejectRelease = false;
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.action === 'client.list') {
        res.end(JSON.stringify({ success: true, data: [{ id: 'browser-a', active: true, paired: true }] }));
        return;
      }
      const type = message.params?.params?.type;
      if (type) events.push(type);
      const error = type === input.down ? 'Lost acknowledgement after applying input'
        : rejectRelease && type === input.up ? 'Release also failed' : undefined;
      res.end(JSON.stringify(error ? { success: false, error } : { success: true, data: {} }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await runCli([...input.args, '-t', '123', '-k', '--server', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--token', 'test']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Lost acknowledgement');
      expect(events).toContain(input.down);
      expect(events.at(-1)).toBe(input.up);
      rejectRelease = true;
      events.length = 0;
      const bothFailed = await runCli([...input.args, '-t', '123', '-k', '--server', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--token', 'test']);
      expect(bothFailed.code).toBe(1);
      expect(bothFailed.stderr).toContain('Lost acknowledgement');
      expect(bothFailed.stderr).not.toContain('Release also failed');
      expect(events.at(-1)).toBe(input.up);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
