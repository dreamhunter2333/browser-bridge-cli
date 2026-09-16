import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

test('debugger idle timeout refreshes on commands and live capture', async () => {
  let now = 0, timerId = 0, attached = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const event = () => ({ addListener() {} });
  const context = createContext({
    console, crypto: webcrypto, TextEncoder,
    setTimeout(fn: () => void, delay: number) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    chrome: {
      storage: { local: { get(_keys: any, cb: any) { cb({ enabled: false }); } } },
      alarms: { onAlarm: event() }, runtime: { onMessage: event(), lastError: null },
      tabs: { onRemoved: event(), async get(id: number) { return { id, url: 'https://test.example' }; } },
      debugger: {
        onEvent: event(), onDetach: event(),
        attach(_target: any, _version: any, cb: any) { attached = true; cb(); },
        detach(_target: any, cb?: any) { attached = false; cb?.(); return Promise.resolve(); },
        sendCommand(_target: any, _method: any, _params: any, cb: any) { cb({ result: { value: 1 } }); },
      },
    },
  });
  runInContext(readFileSync('extension/background.js', 'utf8'), context);
  const call = (action: string, params: any) => {
    context.action = action; context.params = params;
    return runInContext('handleAction(action, params)', context);
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id); timer.fn();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
  };
  const command = () => call('cdp', { tabId: 1, method: 'Runtime.evaluate', keepAttached: true });
  await command();
  await advance(299999); expect(attached).toBe(true);
  await command();
  await advance(299999); expect(attached).toBe(true);
  await advance(1); expect(attached).toBe(false);
  await command();
  const lease = await call('cdp.retain', { tabId: 1 });
  for (let i = 0; i < 10; i++) {
    await advance(40000);
    await call('cdp.frames', { tabId: 1, leaseId: lease.leaseId });
  }
  expect(attached).toBe(true);
  await call('cdp.release', { tabId: 1, leaseId: lease.leaseId });
  await advance(299999); expect(attached).toBe(true);
  await advance(1); expect(attached).toBe(false);
});
