import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

test('stored cursor preference survives worker startup and updates without disabling input', async () => {
  const state = { enabled: false, showOperationCursor: false };
  const methods: Array<{ method: string; params: any }> = [];
  let listener: any;
  const event = () => ({ addListener() {} });
  const context = createContext({
    console, setTimeout() { return 1; }, clearTimeout() {},
    chrome: {
      storage: { local: { get(_keys: any, callback?: any) { if (callback) callback(state); else return Promise.resolve(state); } } },
      alarms: { onAlarm: event() },
      runtime: { onMessage: { addListener(fn: any) { listener = fn; } }, lastError: null },
      tabs: { onRemoved: event(), async get(id: number) { return { id, url: 'https://test.example' }; } },
      debugger: {
        onEvent: event(), onDetach: event(),
        attach(_target: any, _version: any, callback: any) { callback(); },
        detach(_target: any, callback?: any) { callback?.(); return Promise.resolve(); },
        sendCommand(_target: any, method: string, params: any, callback: any) { methods.push({ method, params }); callback({}); },
      },
    },
  });
  runInContext(readFileSync('extension/background.js', 'utf8'), context);
  const move = () => runInContext("handleAction('cdp', {tabId:1,method:'Input.dispatchMouseEvent',params:{type:'mouseMoved',x:10,y:20}})", context);
  const update = () => new Promise(resolve => listener({ type: 'settingsUpdated' }, {}, resolve));
  await move();
  expect(methods.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
  expect(methods.some(call => call.method === 'Runtime.evaluate')).toBe(false);
  state.showOperationCursor = true;
  await update();
  methods.length = 0;
  await move();
  expect(methods.some(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('createElement'))).toBe(true);
  state.showOperationCursor = false;
  await update();
  methods.length = 0;
  await move();
  expect(methods.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
  expect(methods.some(call => call.method === 'Runtime.evaluate')).toBe(false);
});
