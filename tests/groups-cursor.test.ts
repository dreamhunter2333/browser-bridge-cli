import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, apiCall, generateCode, launchBrowserWithExtension, getExtensionPopup, runCli, type ServerInstance } from './helpers';

test.describe('Tab groups and visible cursor', () => {
  let server: ServerInstance;
  let context: BrowserContext;
  const cli = (args: string[]) => runCli([...args, '--server', server.baseUrl, '--token', server.token]);
  const json = async (args: string[]) => {
    const result = await cli(args);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const tabId = async (page: Page) => {
    await page.bringToFront();
    const result = await apiCall(server.baseUrl, server.token, 'tabs.current');
    return (result.body.data as any).id as number;
  };
  const worker = () => context.serviceWorkers()[0];

  test.beforeAll(async () => {
    test.setTimeout(90000);
    server = await startServer();
    context = await launchBrowserWithExtension(`ws://127.0.0.1:${server.port}/ext`);
    const popup = await getExtensionPopup(context);
    if (!(await popup.locator('#enabledToggle').isChecked())) await popup.locator('#enabledToggle').evaluate((el: HTMLInputElement) => el.click());
    await popup.locator('#urlInput2').fill(`ws://127.0.0.1:${server.port}/ext`);
    const code = await generateCode(server.baseUrl, server.token);
    for (let i = 0; i < 6; i++) await popup.locator('#codeBoxes input').nth(i).fill(code[i]);
    await popup.locator('#pairBtn').click();
    await expect(popup.locator('#statusMain')).toContainText('Connected', { timeout: 30000 });
    await popup.close();
  });
  test.afterAll(async () => { await context?.close(); stopServer(server); });

  test('CLI group CRUD, membership, filters and tab group visibility', async () => {
    const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
    try {
      const ids: number[] = [];
      for (const page of pages) ids.push(await tabId(page));
      const group = await json(['groups', 'create', String(ids[0]), String(ids[1]), '--title', '御坂工作组', '--color', 'blue']);
      expect(group).toMatchObject({ title: '御坂工作组', color: 'blue', collapsed: false, tabIds: ids.slice(0, 2) });
      const id = String(group.id);
      expect(await json(['groups', 'get', id])).toEqual(group);
      expect((await json(['groups'])).map((g: any) => g.id)).toContain(group.id);
      expect(await json(['groups', 'list', '--title', '御坂*', '--window', String(group.windowId), '--color', 'blue', '--expanded'])).toEqual([group]);
      const tabs = await json(['tabs', '--json', '--group', id]);
      expect(tabs.map((tab: any) => tab.id)).toEqual(ids.slice(0, 2));
      expect(tabs.every((tab: any) => tab.groupId === group.id)).toBe(true);
      const tab = await json(['tab', String(ids[0])]);
      expect(tab.groupId).toBe(group.id);
      const ungrouped = await json(['tabs', '--json', '--group', '-1', '--window', String(group.windowId)]);
      expect(ungrouped.map((tab: any) => tab.id)).toContain(ids[2]);

      const updated = await json(['groups', 'update', id, '--title', '第二组', '--color', 'red', '--collapsed']);
      expect(updated).toMatchObject({ id: group.id, title: '第二组', color: 'red', collapsed: true });
      expect((await json(['groups', 'list', '--collapsed', '--color', 'red'])).map((g: any) => g.id)).toContain(group.id);
      expect(await json(['groups', 'list', '--expanded', '--color', 'red'])).toEqual([]);
      expect(await json(['groups', 'update', id, '--expanded', '--title', ''])).toMatchObject({ collapsed: false, title: '' });

      expect((await json(['groups', 'add-tabs', id, String(ids[2]), String(ids[2])])).tabIds).toHaveLength(3);
      await json(['groups', 'remove-tabs', String(ids[1])]);
      expect((await json(['tab', String(ids[1])])).groupId).toBe(-1);
      expect((await json(['groups', 'get', id])).tabIds).toEqual([ids[0], ids[2]]);
      const removed = await json(['groups', 'delete', id]);
      expect(removed.ungroupedTabIds).toEqual([ids[0], ids[2]]);
      expect((await json(['groups'])).some((g: any) => g.id === group.id)).toBe(false);
      for (const tabId of ids) expect((await json(['tab', String(tabId)])).groupId).toBe(-1);
    } finally { for (const page of pages) await page.close(); }
  });

  test('group moves within and between windows, and tabs move across groups', async () => {
    const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
    let windowId: number | undefined;
    try {
      const ids: number[] = [];
      for (const page of pages) ids.push(await tabId(page));
      const first = await json(['groups', 'create', String(ids[0]), String(ids[1]), '--color', 'green']);
      const second = await json(['groups', 'create', String(ids[2]), '--color', 'pink']);
      expect((await json(['groups', 'add-tabs', String(second.id), String(ids[1])])).tabIds).toContain(ids[1]);
      expect((await json(['groups', 'get', String(first.id)])).tabIds).toEqual([ids[0]]);
      const reordered = await json(['groups', 'move', String(second.id), '--index', '0']);
      expect((await json(['tab', String(reordered.tabIds[0])])).index).toBe(0);
      const newWindow = await worker().evaluate(async () => (globalThis as any).chrome.windows.create({ url: 'about:blank', focused: false }));
      windowId = newWindow.id;
      const moved = await json(['groups', 'move', String(second.id), '--window', String(windowId), '--index', '-1']);
      expect(moved.windowId).toBe(windowId);
      for (const id of [ids[1], ids[2]]) expect((await json(['tab', String(id)])).windowId).toBe(windowId);
      const joined = await json(['groups', 'add-tabs', String(moved.id), String(ids[0])]);
      expect(joined.tabIds).toHaveLength(3);
      expect((await json(['tab', String(ids[0])])).windowId).toBe(windowId);
      expect((await json(['groups'])).some((g: any) => g.id === first.id)).toBe(false);
      await json(['groups', 'remove-tabs', ...ids.map(String)]);
      expect((await json(['groups'])).some((g: any) => g.id === moved.id)).toBe(false);
    } finally {
      for (const page of pages) if (!page.isClosed()) await page.close();
      if (windowId != null) await worker().evaluate(async id => { try { await (globalThis as any).chrome.windows.remove(id); } catch {} }, windowId);
    }
  });

  test('invalid group commands do not create groups or change tab membership', async () => {
    const page = await context.newPage();
    try {
      const id = String(await tabId(page));
      const before = await json(['groups']);
      for (const args of [
        ['groups', 'create'], ['groups', 'create', id, '--color', 'invalid'],
        ['groups', 'create', id, '--collapsed', '--expanded'], ['groups', 'update', '1'],
        ['groups', 'get', 'NaN'], ['groups', 'get', '-1'], ['groups', 'get', '1.5'],
        ['groups', 'move', '1', '--index', '-2'], ['groups', 'move', '1', '--index', 'NaN'],
        ['groups', 'list', '--collapsed', '--expanded'], ['tabs', '--group', '1.5'],
        ['groups', 'get', '999999999'], ['groups', 'delete', '999999999'],
        ['groups', 'add-tabs', '999999999', id],
      ]) {
        const result = await cli(args);
        expect(result.code, args.join(' ')).toBe(1);
      }
      expect(await json(['groups'])).toEqual(before);
      expect((await json(['tab', id])).groupId).toBe(-1);
    } finally { await page.close(); }
  });

  test('group creation targets a selected window and invalid bulk IDs leave tabs unchanged', async () => {
    const page = await context.newPage();
    let windowId: number | undefined;
    try {
      const id = await tabId(page);
      const created = await worker().evaluate(async () => (globalThis as any).chrome.windows.create({ url: 'about:blank', focused: false }));
      windowId = created.id;
      const group = await json(['groups', 'create', String(id), '--window', String(windowId), '--title', '目标窗口']);
      expect(group).toMatchObject({ windowId, title: '目标窗口', tabIds: [id] });
      expect((await json(['tab', String(id)])).windowId).toBe(windowId);
      for (const args of [
        ['groups', 'create', String(id), '999999999'],
        ['groups', 'add-tabs', String(group.id), String(id), '999999999'],
        ['groups', 'remove-tabs', String(id), '999999999'],
      ]) expect((await cli(args)).code, args.join(' ')).toBe(1);
      expect(await json(['groups', 'get', String(group.id)])).toEqual(group);
    } finally {
      if (!page.isClosed()) await page.close();
      if (windowId != null) await worker().evaluate(async id => { try { await (globalThis as any).chrome.windows.remove(id); } catch {} }, windowId);
    }
  });

  test('group mutations check every member against the whitelist before applying changes', async () => {
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    const popup = await getExtensionPopup(context);
    try {
      await pages[0].goto('data:text/html,allowed');
      await pages[1].goto('data:text/html,blocked');
      const ids = [await tabId(pages[0]), await tabId(pages[1])];
      const group = await json(['groups', 'create', ...ids.map(String), '--title', 'original']);
      await popup.evaluate(async () => {
        await (globalThis as any).chrome.storage.local.set({ whitelistEnabled: true, whitelist: ['data:text/html,allowed'] });
        await (globalThis as any).chrome.runtime.sendMessage({ type: 'whitelistUpdated' });
      });
      await expect.poll(async () => (await apiCall(server.baseUrl, server.token, 'whitelist.get')).body.data).toMatchObject({ whitelistEnabled: true });
      for (const args of [
        ['groups', 'update', String(group.id), '--title', 'changed'],
        ['groups', 'move', String(group.id), '--index', '0'],
        ['groups', 'delete', String(group.id)],
        ['groups', 'remove-tabs', ...ids.map(String)],
        ['groups', 'add-tabs', String(group.id), String(ids[0])],
      ]) {
        const result = await cli(args);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Blocked by whitelist');
      }
      expect(await json(['groups', 'get', String(group.id)])).toEqual(group);
      expect((await json(['tabs', '--json', '--group', String(group.id)])).map((tab: any) => tab.id)).toEqual(ids);
      const create = await cli(['groups', 'create', ...ids.map(String)]);
      expect(create.code).toBe(1);
      expect(create.stderr).toContain('Blocked by whitelist');
    } finally {
      await popup.evaluate(async () => {
        await (globalThis as any).chrome.storage.local.set({ whitelistEnabled: false, whitelist: [] });
        await (globalThis as any).chrome.runtime.sendMessage({ type: 'whitelistUpdated' });
      });
      await popup.close();
      for (const page of pages) await page.close();
    }
  });

  test('cursor follows input, cannot intercept clicks, and is visible in CLI screenshots', async () => {
    const page = await context.newPage();
    const file = path.join(os.tmpdir(), `bb-cursor-${Date.now()}.png`);
    try {
      await page.setContent('<body style="margin:0;background:black;height:3000px"><button style="position:absolute;left:100px;top:100px;width:100px;height:60px" onclick="window.clicked=true">click</button></body>');
      const id = String(await tabId(page));
      await json(['move', '300', '200', '-t', id]);
      const cursor = page.locator('#browser-bridge-cursor');
      await expect(cursor).toHaveAttribute('data-x', '300');
      await expect(cursor).toHaveAttribute('data-y', '200');
      expect(await cursor.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
      expect(await cursor.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))).toEqual({ width: 20, height: 20 });
      const shot = await cli(['screenshot', '-t', id, '-o', file]);
      expect(shot.code, shot.stderr).toBe(0);
      const png = PNG.sync.read(fs.readFileSync(file));
      const at = (200 + 6) * png.width * 4 + (300 + 4) * 4;
      expect(Array.from(png.data.subarray(at, at + 3))).toEqual([59, 130, 246]);
      await json(['click', '--x', '150', '--y', '130', '-t', id]);
      expect(await page.evaluate(() => (window as any).clicked)).toBe(true);
      await expect(cursor).toHaveAttribute('data-x', '150');
      await expect(cursor).toHaveAttribute('data-pressed', 'false');
      const down = await cli(['cdp', 'Input.dispatchMouseEvent', JSON.stringify({ type: 'mousePressed', x: 150, y: 130, button: 'left', buttons: 1, clickCount: 1 }), '-t', id, '-k']);
      expect(down.code, down.stderr).toBe(0);
      await expect(cursor).toHaveAttribute('data-pressed', 'true');
      expect(await cursor.evaluate(el => getComputedStyle(el).color)).toBe('rgb(37, 99, 235)');
      await cli(['cdp', 'Input.dispatchMouseEvent', JSON.stringify({ type: 'mouseReleased', x: 150, y: 130, button: 'left', buttons: 0, clickCount: 1 }), '-t', id]);
      await expect(cursor).toHaveAttribute('data-pressed', 'false');
      expect(await cursor.evaluate(el => getComputedStyle(el).color)).toBe('rgb(59, 130, 246)');
      await page.goto('about:blank');
      await expect(page.locator('#browser-bridge-cursor')).toHaveCount(0);
    } finally {
      await page.close();
      try { fs.unlinkSync(file); } catch {}
    }
  });

  test('cursor hides after three idle seconds, resets on input and reappears on new input', async () => {
    const page = await context.newPage();
    try {
      await page.setContent('<body style="height:3000px"><button style="position:absolute;left:100px;top:100px;width:100px;height:60px" onclick="window.clicked=true">click</button></body>');
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      const id = String(await tabId(page));
      const cursor = page.locator('#browser-bridge-cursor');
      await json(['move', '300', '200', '-t', id]);
      await expect(cursor).toHaveCount(1);
      await page.clock.runFor(2000);
      await json(['move', '400', '200', '-t', id]);
      await page.clock.runFor(2000);
      await expect(cursor).toHaveAttribute('data-x', '400');
      await page.clock.runFor(999);
      await expect(cursor).toHaveCount(1);
      await page.clock.runFor(1);
      await expect(cursor).toHaveCount(0);
      await json(['click', '--x', '150', '--y', '130', '-t', id]);
      await expect(cursor).toHaveCount(1);
      expect(await page.evaluate(() => (window as any).clicked)).toBe(true);
      await page.clock.runFor(3000);
      await expect(cursor).toHaveCount(0);
    } finally {
      await page.clock.resume();
      await page.close();
    }
  });

  test('cursor remains visible over modal dialogs on Trusted Types pages', async () => {
    const page = await context.newPage();
    const file = path.join(os.tmpdir(), `bb-cursor-modal-${Date.now()}.png`);
    try {
      await page.route('http://bb-cursor.test/', route => route.fulfill({
        headers: { 'content-type': 'text/html', 'content-security-policy': "require-trusted-types-for 'script'; script-src 'unsafe-inline'" },
        body: '<dialog style="margin:0;top:0;left:0;width:100vw;height:100vh;max-width:none;max-height:none;box-sizing:border-box;background:black;border:0"><button id="modal-button" style="position:absolute;left:100px;top:100px;width:100px;height:60px" onclick="window.clicked=true">click</button></dialog><script>document.querySelector("dialog").showModal()</script>',
      }));
      await page.goto('http://bb-cursor.test/');
      const id = String(await tabId(page));
      await json(['move', '300', '200', '-t', id]);
      await expect(page.locator('#browser-bridge-cursor')).toHaveCount(1);
      const shot = await cli(['screenshot', '-t', id, '-o', file]);
      expect(shot.code, shot.stderr).toBe(0);
      const png = PNG.sync.read(fs.readFileSync(file));
      const at = (200 + 6) * png.width * 4 + (300 + 4) * 4;
      expect(Array.from(png.data.subarray(at, at + 3))).toEqual([59, 130, 246]);
      await json(['click', '#modal-button', '-t', id]);
      expect(await page.evaluate(() => (window as any).clicked)).toBe(true);
    } finally {
      await page.close();
      try { fs.unlinkSync(file); } catch {}
    }
  });
});
