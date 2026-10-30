import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

test('screencast coordinate changes start a new keyframe without making every frame a keyframe', async () => {
  const event = () => ({ addListener() {} });
  let lastImage: string | undefined;
  const context = createContext({
    console, crypto: webcrypto, TextEncoder, setTimeout() { return 1; }, clearTimeout() {},
    chrome: {
      storage: { local: { get(_keys: any, cb: any) { cb({ enabled: false }); } } },
      alarms: { onAlarm: event() },
      runtime: {
        onMessage: event(), lastError: null,
        async sendMessage(message: any) {
          if (message.operation !== 'encode') return {};
          if (lastImage === message.data && !message.keyFrame) return { unchanged: true };
          lastImage = message.data;
          return { type: message.keyFrame ? 'key' : 'delta', data: 'encoded', width: 100, height: 100 };
        },
      },
      tabs: { onRemoved: event(), async get(id: number) { return { id, url: 'https://test.example' }; } },
      debugger: {
        onEvent: event(), onDetach: event(),
        attach(_target: any, _version: any, cb: any) { cb(); },
        detach(_target: any, cb?: any) { cb?.(); return Promise.resolve(); },
        sendCommand(_target: any, _method: any, _params: any, cb: any) { cb({}); },
      },
    },
  });
  runInContext(readFileSync('extension/background.js', 'utf8'), context);
  const lease = await runInContext("handleAction('cdp.retain', {tabId:1})", context);
  const frame = async (sequence: number, width: number, image: string, keyFrame = false) => {
    context.frame = { sequence, data: image, metadata: { deviceWidth: width } };
    context.params = { tabId: 1, leaseId: lease.leaseId, since: sequence - 1, keyFrame };
    runInContext('debuggerLeases.get(1).capture=true; debuggerLeases.get(1).frame=frame', context);
    return await runInContext("handleAction('cdp.frames', params)", context);
  };
  expect((await frame(1, 100, 'first', true)).frame.video.type).toBe('key');
  expect((await frame(2, 101, 'second')).frame.video.type).toBe('key');
  expect((await frame(3, 101, 'third')).frame.video.type).toBe('delta');
  expect((await frame(4, 102, 'third')).frame.video.type).toBe('key');
  expect((await frame(5, 102, 'third')).frame).toBeNull();
});
