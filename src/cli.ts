#!/usr/bin/env node
import { program } from 'commander';
import { request, health, ensureServer, getBridgeUrl, getActiveClientId, setGlobalOpts, resolveConfig, pairWithServer, saveConfig, loadConfigFile, resetConfig, isLocalServer, STATE_DIR } from './client.js';
import { parseId, registerGroupCommands } from './groups.js';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { PNG } from 'pngjs';

function out(data: unknown) {
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readPackageVersion(): string {
  try {
    const cliDir = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.resolve(cliDir, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { version?: string };

    if (packageJson.version) return packageJson.version;
    return '0.0.0';
  } catch {
    return '0.0.0';
  }
}

type ScreenshotClipOptions = {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  maxHeight?: number | string;
  long?: boolean;
  hideSticky?: boolean;
  tab?: number;
};

type RuntimeEvalResult = {
  result?: { value?: unknown };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
};

type PageMetrics = {
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

type PngImage = PNG & { data: Buffer };

function assertValidClip(x: number, y: number, width: number, height: number) {
  if (x < 0 || y < 0) throw new Error(`Invalid screenshot clip origin: ${x},${y}`);
  if (width <= 0 || height <= 0) throw new Error(`Invalid screenshot clip size: ${width}x${height}`);
}

function readOptionalPixel(value: number | string | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) throw new Error(`Invalid ${name}: ${value}`);
  return Math.ceil(numberValue);
}

async function sendCdp(tabId: number | undefined, method: string, params: Record<string, unknown> = {}, clientId?: string) {
  return await request('cdp', { tabId, method, params, keepAttached: true }, clientId);
}

async function detachCdp(tabId: number | undefined, clientId?: string) {
  await request('cdp.detach', { tabId }, clientId).catch(() => {});
}

async function evaluateCdpExpression(
  expression: string,
  opts: { tab?: number; keepAttached?: boolean; clientId?: string } = {}
): Promise<unknown> {
  try {
    const result = await sendCdp(opts.tab, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, opts.clientId) as RuntimeEvalResult;

    if (result.exceptionDetails) {
      const error = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Eval error';
      throw new Error(error);
    }

    return result.result?.value;
  } finally {
    if (opts.keepAttached !== true) await detachCdp(opts.tab, opts.clientId);
  }
}

async function getPageMetrics(tabId: number | undefined): Promise<PageMetrics> {
  const value = await evaluateCdpExpression(`JSON.stringify((() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: Math.max(doc.scrollWidth, body?.scrollWidth || 0, window.innerWidth),
      scrollHeight: Math.max(doc.scrollHeight, body?.scrollHeight || 0, window.innerHeight),
    };
  })())`, { tab: tabId, keepAttached: true });

  if (typeof value !== 'string') throw new Error('Failed to read page metrics');
  return JSON.parse(value) as PageMetrics;
}

const visibilityHelpers = `
  const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    && Array.from(el.getClientRects()).some(r => r.width > 0 && r.height > 0);
  const inViewport = el => Array.from(el.getClientRects()).some(r =>
    r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight);
`;

function buildQueryExpression(selector: string, limit?: number, visible = false, inViewport = false): string {
  const safeLimit = Number.isFinite(limit) ? limit as number : 50;
  return `JSON.parse(JSON.stringify((() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    ${visibilityHelpers}
    const out = [];
    const limit = ${safeLimit};
    for (const el of els) {
      if (out.length >= limit) break;
      if (${visible || inViewport} && !visible(el)) continue;
      if (${inViewport} && !inViewport(el)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        className: el.className || undefined,
        text: el.textContent?.slice(0, 200),
        href: el.href || undefined,
        src: el.src || undefined,
        rect: el.getBoundingClientRect().toJSON(),
      });
    }
    return out;
  })()))`;
}

type InputOptions = { tab?: number; keepAttached?: boolean; x?: string; y?: string };
type InputPoint = { x: number; y: number };
type InputTarget = { tab: number; clientId: string };

function inputNumber(value: string, name: string): number {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`Invalid ${name}: ${value}`);
  return Number(value);
}

async function withInput(opts: InputOptions, action: (target: InputTarget) => Promise<void>) {
  if (opts.tab != null && (!Number.isSafeInteger(opts.tab) || opts.tab < 0)) throw new Error('Invalid tab ID');
  const clientId = await getActiveClientId();
  const tab = opts.tab ?? (await request('tabs.current', {}, clientId) as { id: number }).id;
  const target = { tab, clientId };
  try {
    await action(target);
    out({ ok: true });
  } finally {
    if (!opts.keepAttached) await detachCdp(tab, clientId);
  }
}

function readInputCoordinates(selector: string | undefined, opts: InputOptions): InputPoint | undefined {
  if (selector != null && (opts.x != null || opts.y != null)) throw new Error('Use a selector or --x/--y, not both');
  if ((opts.x == null) !== (opts.y == null)) throw new Error('Both --x and --y are required');
  if (opts.x == null || opts.y == null) return undefined;
  const x = inputNumber(opts.x, 'x'), y = inputNumber(opts.y, 'y');
  if (x < 0 || y < 0) throw new Error('Coordinates must be non-negative viewport CSS pixels');
  return { x, y };
}

async function inputPoint(target: InputTarget, selector?: string, coordinates?: InputPoint): Promise<InputPoint> {
  if (coordinates) return coordinates;
  return await evaluateCdpExpression(`(async () => {
    if (${selector == null}) return { x: innerWidth / 2, y: innerHeight / 2 };
    ${visibilityHelpers}
    const matches = Array.from(document.querySelectorAll(${JSON.stringify(selector ?? '')})).filter(visible);
    if (matches.length !== 1) throw new Error('Expected one visible element, found ' + matches.length);
    const el = matches[0];
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!el.isConnected || !visible(el)) throw new Error('Element is no longer visible');
    for (const r of el.getClientRects()) {
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      if (right <= left || bottom <= top) continue;
      const x = (left + right) / 2, y = (top + bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return { x, y };
    }
    throw new Error('Element is outside the viewport or covered by another element');
  })()`, { ...target, keepAttached: true }) as InputPoint;
}

async function moveToInput(target: InputTarget, selector?: string, coordinates?: InputPoint): Promise<InputPoint> {
  let point = await inputPoint(target, selector, coordinates);
  for (let attempt = 0; attempt < 3; attempt++) {
    await sendCdp(target.tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, target.clientId);
    if (selector == null) return point;
    const next = await inputPoint(target, selector);
    if (next.x === point.x && next.y === point.y) return point;
    point = next;
  }
  throw new Error('Element did not stay under the pointer');
}

async function sendInputPair(target: InputTarget, method: string, down: Record<string, unknown>, up: Record<string, unknown>) {
  try {
    await sendCdp(target.tab, method, down, target.clientId);
  } catch (error) {
    await sendCdp(target.tab, method, up, target.clientId).catch(() => {});
    throw error;
  }
  await sendCdp(target.tab, method, up, target.clientId);
}

async function printCdpPdf(tabId: number | undefined): Promise<string> {
  try {
    const result = await sendCdp(tabId, 'Page.printToPDF', { printBackground: true }) as { data: string };
    return result.data;
  } finally {
    await detachCdp(tabId);
  }
}

async function captureCdpViewport(tabId: number | undefined): Promise<string> {
  try {
    const result = await sendCdp(tabId, 'Page.captureScreenshot', { format: 'png' }) as { data: string };
    return result.data;
  } finally {
    await detachCdp(tabId);
  }
}

function decodePng(base64: string): PngImage {
  return PNG.sync.read(Buffer.from(base64, 'base64')) as PngImage;
}

function copyPngRows(source: PngImage, target: PngImage, targetY: number, sourceY: number, height: number) {
  const rowBytes = source.width * 4;
  for (let row = 0; row < height; row++) {
    const sourceStart = (sourceY + row) * rowBytes;
    const targetStart = (targetY + row) * rowBytes;
    source.data.copy(target.data, targetStart, sourceStart, sourceStart + rowBytes);
  }
}

async function setViewport(tabId: number | undefined, width: number, height: number) {
  await sendCdp(tabId, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function scrollToAndWait(tabId: number | undefined, x: number, y: number) {
  await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `new Promise(resolve => {
      window.scrollTo(${x}, ${y});
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`,
    awaitPromise: true,
  });
}

async function installLongScreenshotStyle(tabId: number | undefined) {
  await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      document.documentElement.setAttribute('data-browser-bridge-long-active', '1');
      const styleId = 'browser-bridge-long-screenshot-style';
      if (document.getElementById(styleId)) return;
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = [
        'html[data-browser-bridge-long-active="1"], html[data-browser-bridge-long-active="1"] body { scrollbar-width: none !important; -ms-overflow-style: none !important; }',
        'html[data-browser-bridge-long-active="1"]::-webkit-scrollbar, html[data-browser-bridge-long-active="1"] *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }',
        '[data-browser-bridge-long-hidden="1"] { visibility: hidden !important; }',
      ].join('\\n');
      document.documentElement.appendChild(style);
    })()`,
  });
}

async function hideLongScreenshotRepeatingElements(tabId: number | undefined, hideSticky: boolean) {
  await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const valueKey = 'browserBridgeLongOriginalVisibility';
      const priorityKey = 'browserBridgeLongOriginalVisibilityPriority';
      for (const el of document.querySelectorAll('*')) {
        const position = getComputedStyle(el).position;
        if (position !== 'fixed' && !(position === 'sticky' && ${hideSticky})) continue;
        if (!(valueKey in el.dataset)) {
          el.dataset[valueKey] = el.style.getPropertyValue('visibility') || '';
          el.dataset[priorityKey] = el.style.getPropertyPriority('visibility') || '';
        }
        el.setAttribute('data-browser-bridge-long-hidden', '1');
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    })()`,
  });
}

async function restoreLongScreenshotRepeatingElements(tabId: number | undefined) {
  await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('browser-bridge-long-screenshot-style')?.remove();
      document.documentElement.removeAttribute('data-browser-bridge-long-active');
      const valueKey = 'browserBridgeLongOriginalVisibility';
      const priorityKey = 'browserBridgeLongOriginalVisibilityPriority';
      for (const el of document.querySelectorAll('[data-browser-bridge-long-hidden="1"]')) {
        const value = el.dataset[valueKey] || '';
        const priority = el.dataset[priorityKey] || '';
        if (value) el.style.setProperty('visibility', value, priority);
        else el.style.removeProperty('visibility');
        delete el.dataset[valueKey];
        delete el.dataset[priorityKey];
        el.removeAttribute('data-browser-bridge-long-hidden');
      }
    })()`,
  }).catch(() => {});
}

async function captureCdpLong(opts: ScreenshotClipOptions): Promise<Buffer> {
  let originalScroll = { x: 0, y: 0 };
  const slices: Array<{ png: PngImage; sourceY: number; height: number }> = [];

  try {
    const originalMetrics = await getPageMetrics(opts.tab);
    const requestedX = readOptionalPixel(opts.x, 'x');
    const requestedY = readOptionalPixel(opts.y, 'y');
    const requestedWidth = readOptionalPixel(opts.width, 'width');
    const requestedMaxHeight = readOptionalPixel(opts.maxHeight, 'max-height') ?? 30000;
    const requestedHeight = readOptionalPixel(opts.height, 'height');
    const x = requestedX ?? 0;
    const y = requestedY ?? 0;
    const width = requestedWidth ?? originalMetrics.viewportWidth;
    assertValidClip(x, y, width, 1);

    originalScroll = { x: originalMetrics.scrollX, y: originalMetrics.scrollY };
    await setViewport(opts.tab, width, originalMetrics.viewportHeight);
    await installLongScreenshotStyle(opts.tab);

    const metrics = await getPageMetrics(opts.tab);
    const pageHeight = Math.max(0, metrics.scrollHeight - y);
    const clipHeight = Math.min(pageHeight, requestedHeight ?? pageHeight);
    const height = Math.min(clipHeight, requestedMaxHeight);
    assertValidClip(x, y, width, height);
    if (clipHeight > height) {
      console.error(`Long screenshot limited to ${height}px; requested height from y=${y} is ${clipHeight}px.`);
    }

    let capturedCssHeight = 0;
    let outputWidth = 0;
    let outputHeight = 0;
    let deviceScale = 1;
    const maxPageScrollY = Math.max(0, metrics.scrollHeight - metrics.viewportHeight);
    const maxClipScrollY = y + Math.max(0, height - metrics.viewportHeight);

    while (capturedCssHeight < height) {
      const remainingCssHeight = height - capturedCssHeight;
      const targetCssY = y + capturedCssHeight;
      const scrollY = Math.min(targetCssY, maxClipScrollY, maxPageScrollY);
      const sourceCssY = targetCssY - scrollY;

      await scrollToAndWait(opts.tab, x, scrollY);
      if (slices.length > 0) await hideLongScreenshotRepeatingElements(opts.tab, opts.hideSticky === true);

      const result = await sendCdp(opts.tab, 'Page.captureScreenshot', { format: 'png' }) as { data: string };
      const png = decodePng(result.data);
      if (slices.length === 0) {
        outputWidth = png.width;
        deviceScale = png.height / metrics.viewportHeight;
      } else if (png.width !== outputWidth) {
        throw new Error(`Long screenshot slice width changed: ${outputWidth} -> ${png.width}`);
      }

      const sliceCssHeight = Math.min(metrics.viewportHeight - sourceCssY, remainingCssHeight);
      const sourcePixelY = Math.max(0, Math.round(sourceCssY * deviceScale));
      const slicePixelHeight = Math.min(png.height - sourcePixelY, Math.ceil(sliceCssHeight * deviceScale));
      slices.push({ png, sourceY: sourcePixelY, height: slicePixelHeight });
      outputHeight += slicePixelHeight;
      capturedCssHeight += sliceCssHeight;
    }

    const stitched = new PNG({ width: outputWidth, height: outputHeight }) as PngImage;
    let targetY = 0;
    for (const slice of slices) {
      copyPngRows(slice.png, stitched, targetY, slice.sourceY, slice.height);
      targetY += slice.height;
    }

    return PNG.sync.write(stitched);
  } finally {
    await restoreLongScreenshotRepeatingElements(opts.tab);
    await sendCdp(opts.tab, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await sendCdp(opts.tab, 'Runtime.evaluate', {
      expression: `window.scrollTo(${originalScroll.x || 0}, ${originalScroll.y || 0})`,
    }).catch(() => {});
    await detachCdp(opts.tab);
  }
}

async function captureCdpClip(opts: ScreenshotClipOptions): Promise<string> {
  let originalScroll = { x: 0, y: 0 };
  try {
    const metrics = await getPageMetrics(opts.tab);
    const requestedX = readOptionalPixel(opts.x, 'x');
    const requestedY = readOptionalPixel(opts.y, 'y');
    const requestedWidth = readOptionalPixel(opts.width, 'width');
    const requestedHeight = readOptionalPixel(opts.height, 'height');
    const x = requestedX ?? 0;
    const y = requestedY ?? 0;
    const contentRight = metrics.scrollWidth;
    const contentBottom = metrics.scrollHeight;
    const width = requestedWidth ?? contentRight - x;
    const height = requestedHeight ?? contentBottom - y;
    assertValidClip(x, y, width, height);

    originalScroll = { x: metrics.scrollX, y: metrics.scrollY };

    await sendCdp(opts.tab, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sendCdp(opts.tab, 'Runtime.evaluate', {
      expression: `new Promise(resolve => { window.scrollTo(${x}, ${y}); requestAnimationFrame(() => resolve()); })`,
      awaitPromise: true,
    });
    const result = await sendCdp(opts.tab, 'Page.captureScreenshot', { format: 'png' }) as { data: string };
    return result.data;
  } finally {
    await sendCdp(opts.tab, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await sendCdp(opts.tab, 'Runtime.evaluate', {
      expression: `window.scrollTo(${originalScroll.x || 0}, ${originalScroll.y || 0})`,
    }).catch(() => {});
    await detachCdp(opts.tab);
  }
}

program
  .name('browser-bridge-cli')
  .version(readPackageVersion())
  .description('Browser Bridge CLI')
  .option('-s, --server <url>', 'Bridge server URL')
  .option('--token <token>', 'Authentication token')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.server || opts.token) {
      setGlobalOpts({ server: opts.server, token: opts.token });
    }
  });

program
  .command('info')
  .description('Check bridge server status')
  .action(async () => {
    await ensureServer();
    const config = resolveConfig(program.opts());
    const h = await fetch(`${config.url}/api/health`, {
      headers: config.token ? { 'X-Browser-Bridge': config.token } : {},
    }).then(r => r.json());
    out(h);
  });

program
  .command('eval <expression>')
  .description('Execute JS expression in active tab')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (expression: string, opts) => {
    const result = await evaluateCdpExpression(expression, opts);
    out(result);
  });

program
  .command('eval-file <file>')
  .description('Execute JS file in active tab')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (file: string, opts) => {
    const code = fs.readFileSync(path.resolve(file), 'utf-8');
    const result = await evaluateCdpExpression(code, opts);
    out(result);
  });

program
  .command('query <selector>')
  .description('Query DOM elements')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-l, --limit <n>', 'Max results', parseInt)
  .option('--visible', 'Only elements with visible layout (may be offscreen or covered)')
  .option('--in-viewport', 'Only visible elements intersecting the viewport (may be covered)')
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (selector: string, opts) => {
    if (opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new Error('Limit must be a positive integer');
    const result = await evaluateCdpExpression(buildQueryExpression(selector, opts.limit, opts.visible, opts.inViewport), opts);
    out(result);
  });

program
  .command('click [selector]')
  .description('Click one visible CSS match, or viewport --x/--y coordinates')
  .option('--x <pixels>', 'Viewport x in CSS pixels')
  .option('--y <pixels>', 'Viewport y in CSS pixels')
  .option('--button <button>', 'left, right or middle', 'left')
  .option('--count <n>', 'Click count: 1 or 2', Number, 1)
  .option('-t, --tab <id>', 'Target tab ID', Number)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (selector, opts) => {
    if (!selector && opts.x == null && opts.y == null) throw new Error('Provide a CSS selector or --x and --y');
    if (!['left', 'right', 'middle'].includes(opts.button)) throw new Error('Button must be left, right or middle');
    if (![1, 2].includes(opts.count)) throw new Error('Click count must be 1 or 2');
    const coordinates = readInputCoordinates(selector, opts);
    await withInput(opts, async target => {
      for (let clickCount = 1; clickCount <= opts.count; clickCount++) {
        const point = await moveToInput(target, selector, coordinates);
        await sendInputPair(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', ...point, button: opts.button,
          buttons: ({ left: 1, right: 2, middle: 4 } as Record<string, number>)[opts.button], clickCount,
        }, {
          type: 'mouseReleased', ...point, button: opts.button, buttons: 0, clickCount,
        });
      }
    });
  });

program
  .command('hover <selector>')
  .description('Move the mouse over one visible CSS match; scroll it into view')
  .option('-t, --tab <id>', 'Target tab ID', Number)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (selector, opts) => {
    await withInput(opts, async target => {
      await moveToInput(target, selector);
    });
  });

program
  .command('move <x> <y>')
  .description('Move the mouse to viewport CSS-pixel coordinates')
  .option('-t, --tab <id>', 'Target tab ID', Number)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (x, y, opts) => {
    const point = readInputCoordinates(undefined, { x, y })!;
    await withInput(opts, async target => {
      await sendCdp(target.tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, target.clientId);
    });
  });

program
  .command('scroll [direction] [pixels]')
  .description('Scroll up/down/left/right (default: down 500), or pass a positive vertical delta')
  .option('--delta-x <pixels>', 'Horizontal wheel delta')
  .option('--delta-y <pixels>', 'Vertical wheel delta (accepts negative values)')
  .option('--selector <css>', 'Scroll over one visible CSS match')
  .option('--x <pixels>', 'Wheel origin x (default: viewport center)')
  .option('--y <pixels>', 'Wheel origin y (default: viewport center)')
  .option('-t, --tab <id>', 'Target tab ID', Number)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (direction: string | undefined, pixels: string | undefined, opts) => {
    const directions: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    if (pixels != null && !directions[direction!]) throw new Error('Pixels require a direction: up, down, left or right');
    if (direction != null && opts.deltaY != null) throw new Error('Use a direction/delta argument or --delta-y, not both');
    const amount = inputNumber(directions[direction!] ? pixels ?? '500' : direction ?? '0', 'deltaY');
    if (amount < 0) throw new Error('Use up/left or --delta-y for negative scrolling');
    const [horizontal, vertical] = directions[direction!] ?? [0, 1];
    const dy = opts.deltaY != null ? inputNumber(opts.deltaY, 'deltaY') : direction == null && opts.deltaX == null ? 500 : vertical * amount;
    const dx = inputNumber(opts.deltaX ?? '0', 'deltaX') + horizontal * amount;
    const coordinates = readInputCoordinates(opts.selector, opts);
    await withInput(opts, async target => {
      const point = await inputPoint(target, opts.selector, coordinates);
      await sendCdp(target.tab, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', ...point, deltaX: dx, deltaY: dy,
      }, target.clientId);
    });
  });

program
  .command('type <text>')
  .description('Insert text into the focused field (supports Unicode; no key events)')
  .option('-t, --tab <id>', 'Target tab ID', Number)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (text, opts) => {
    await withInput(opts, async target => { await sendCdp(target.tab, 'Input.insertText', { text }, target.clientId); });
  });

program
  .command('press <key>')
  .description('Send a key event; the caller supplies key mapping and modifier combinations')
  .option('--code <code>', 'Physical key code, e.g. KeyA or Digit1')
  .option('--key-code <n>', 'Windows virtual key code', Number)
  .option('--modifiers <mask>', 'CDP bitmask: Alt=1, Control=2, Meta=4, Shift=8', Number, 0)
  .option('--text <text>', 'Text produced on key down (otherwise sends rawKeyDown)')
  .option('--commands <names>', 'Comma-separated native editing commands')
  .option('--phase <phase>', 'press (down/up), down or up; down requires -k', 'press')
  .option('-t, --tab <id>', 'Target tab ID', Number)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .action(async (key: string, opts) => {
    if (!key) throw new Error('Key must not be empty');
    if (!Number.isInteger(opts.modifiers) || opts.modifiers < 0 || opts.modifiers > 15) throw new Error('Modifiers must be an integer from 0 to 15');
    if (opts.keyCode != null && (!Number.isInteger(opts.keyCode) || opts.keyCode < 0 || opts.keyCode > 255)) throw new Error('Key code must be an integer from 0 to 255');
    if (!['press', 'down', 'up'].includes(opts.phase)) throw new Error('Phase must be press, down or up');
    if (opts.phase === 'down' && !opts.keepAttached) throw new Error('Key down requires --keep-attached; release it with --phase up on the same tab');
    await withInput(opts, async target => {
      const params = { key, code: opts.code, modifiers: opts.modifiers, windowsVirtualKeyCode: opts.keyCode };
      if (opts.phase === 'up') {
        await sendCdp(target.tab, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' }, target.clientId);
        return;
      }
      const down = {
        ...params, type: opts.text != null ? 'keyDown' : 'rawKeyDown', text: opts.text,
        commands: opts.commands?.split(',').map((name: string) => name.trim()).filter(Boolean),
      };
      if (opts.phase === 'down') {
        await sendCdp(target.tab, 'Input.dispatchKeyEvent', down, target.clientId);
        return;
      }
      await sendInputPair(target, 'Input.dispatchKeyEvent', down, { ...params, type: 'keyUp' });
    });
  });

program
  .command('tabs')
  .description('List all tabs')
  .option('--json', 'Return tab metadata, including groupId (-1 means ungrouped)')
  .option('--group <id>', 'Filter by group ID; -1 means ungrouped', Number)
  .option('--window <id>', 'Filter by window ID', parseId)
  .action(async opts => {
    if (opts.group != null && (!Number.isSafeInteger(opts.group) || opts.group < -1)) throw new Error('Group ID must be an integer greater than or equal to -1');
    const tabs = (await request('tabs.list') as Array<Record<string, unknown>>).filter(tab =>
      (opts.group == null || tab.groupId === opts.group) && (opts.window == null || tab.windowId === opts.window));
    if (opts.json) { out(tabs); return; }
    for (const t of tabs) {
      const marker = t.active ? '*' : ' ';
      console.log(`${marker} [${t.id}] ${t.title}`);
      console.log(`        ${t.url}`);
    }
  });

registerGroupCommands(program);

program
  .command('tab <id>')
  .description('Get tab info')
  .action(async (id: string) => {
    const result = await request('tabs.get', { tabId: parseInt(id) });
    out(result);
  });

program
  .command('activate <id>')
  .description('Switch to a tab (no focus steal)')
  .action(async (id: string) => {
    await request('tabs.activate', { tabId: parseInt(id) });
    console.log(`Activated tab ${id}`);
  });

program
  .command('new-tab [url]')
  .description('Create a new tab')
  .action(async (url?: string) => {
    const result = await request('tabs.create', { url }) as Record<string, unknown>;
    console.log(`Created tab ${result.id}: ${result.url}`);
  });

program
  .command('close-tab <id>')
  .description('Close a tab')
  .action(async (id: string) => {
    await request('tabs.close', { tabId: parseInt(id) });
    console.log(`Closed tab ${id}`);
  });

program
  .command('cdp <method> [params]')
  .description('Send raw CDP command')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('-k, --keep-attached', 'Keep debugger attached (5-minute idle timeout)')
  .option('--session <id>', 'Child CDP session ID (Chrome 125+)')
  .action(async (method: string, paramsJson: string | undefined, opts: { tab?: number; keepAttached?: boolean; session?: string }) => {
    const params = paramsJson ? JSON.parse(paramsJson) : {};
    const result = await request('cdp', { method, params, tabId: opts.tab, keepAttached: opts.keepAttached, sessionId: opts.session });
    out(result);
  });

program
  .command('cdp-events')
  .description('Start/read buffered raw CDP events; 5-minute idle detach')
  .requiredOption('-t, --tab <id>', 'Target tab ID', Number)
  .option('--since <cursor>', 'Read events after this cursor', Number)
  .option('--stream <id>', 'Require the same event stream')
  .option('--method <method>', 'Filter by exact CDP event method')
  .option('--session <id>', 'Filter by child CDP session ID')
  .option('--stop', 'Discard event capture without detaching')
  .action(async (opts) => {
    if (!Number.isSafeInteger(opts.tab) || opts.tab < 0) throw new Error('Invalid tab ID');
    if (opts.since != null && (!Number.isSafeInteger(opts.since) || opts.since < 0)) throw new Error('Invalid event cursor');
    out(await request('cdp.events', {
      tabId: opts.tab, since: opts.since, streamId: opts.stream,
      method: opts.method, sessionId: opts.session, stop: opts.stop,
    }));
  });

program
  .command('detach')
  .description('Detach debugger from tab (removes warning bar)')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (opts) => {
    await request('cdp.detach', { tabId: opts.tab });
    console.log('Detached');
  });

program
  .command('navigate <url>')
  .description('Navigate active tab to URL')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (url: string, opts) => {
    await request('navigate', { url, tabId: opts.tab });
    console.log(`Navigated to ${url}`);
  });

program
  .command('reload')
  .description('Reload active tab')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('--no-cache', 'Bypass cache')
  .action(async (opts) => {
    await request('reload', { tabId: opts.tab, bypassCache: !opts.cache });
    console.log('Reloaded');
  });

program
  .command('screenshot')
  .description('Capture screenshot')
  .option('-o, --output <file>', 'Output file', 'screenshot.png')
  .option('-f, --full', 'Full page screenshot')
  .option('-L, --long', 'Single-image long screenshot with adaptive height')
  .option('--max-height <px>', 'Maximum height for --long', parseInt)
  .option('--hide-sticky', 'Hide sticky elements after the first long-screenshot slice')
  .option('--x <px>', 'Clip x coordinate', parseInt)
  .option('--y <px>', 'Clip y coordinate', parseInt)
  .option('--width <px>', 'Clip width', parseInt)
  .option('--height <px>', 'Clip height', parseInt)
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (opts) => {
    if (opts.long) {
      fs.writeFileSync(opts.output, await captureCdpLong(opts));
      console.log(`Saved to ${opts.output}`);
      return;
    }

    const hasClip = opts.x != null || opts.y != null || opts.width != null || opts.height != null;
    const base64 = opts.full || hasClip
      ? await captureCdpClip(opts)
      : await captureCdpViewport(opts.tab);
    fs.writeFileSync(opts.output, Buffer.from(base64, 'base64'));
    console.log(`Saved to ${opts.output}`);
  });

program
  .command('pdf')
  .description('Export page as PDF')
  .option('-o, --output <file>', 'Output file', 'page.pdf')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (opts) => {
    const dataBase64 = await printCdpPdf(opts.tab);
    fs.writeFileSync(opts.output, Buffer.from(dataBase64, 'base64'));
    console.log(`Saved to ${opts.output}`);
  });

program
  .command('network')
  .description('Get captured network requests')
  .option('-l, --limit <n>', 'Max entries', parseInt)
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .option('--clear', 'Clear network log')
  .action(async (opts) => {
    if (opts.clear) {
      await request('network.clear', { tabId: opts.tab });
      console.log('Network log cleared');
      return;
    }
    const result = await request('network.getAll', { limit: opts.limit, tabId: opts.tab });
    out(result);
  });

program
  .command('cookies')
  .description('Get cookies')
  .option('-u, --url <url>', 'Filter by URL')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('-n, --name <name>', 'Filter by name')
  .option('-t, --tab <id>', 'Target tab ID', parseInt)
  .action(async (opts) => {
    const filter: Record<string, string> = {};
    if (opts.url) filter.url = opts.url;
    if (opts.domain) filter.domain = opts.domain;
    if (opts.name) filter.name = opts.name;
    const result = await request('cookies.get', { filter, tabId: opts.tab });
    out(result);
  });

program
  .command('pair')
  .description('Pair with bridge server')
  .option('-n, --name <name>', 'Client name')
  .action(async (opts) => {
    const parentOpts = program.opts();
    const serverUrl = parentOpts.server || process.env.BROWSER_BRIDGE_URL || loadConfigFile().server;

    if (serverUrl && !isLocalServer(serverUrl)) {
      const code = await prompt('Enter pairing code: ');
      if (!code || code.length !== 6) {
        console.error('Invalid code. Must be 6 digits.');
        process.exit(1);
      }
      const result = await pairWithServer(serverUrl, code, opts.name);
      saveConfig({ server: serverUrl, token: result.token, name: result.name });
      console.log(`Paired as "${result.name}". Config saved.`);
      return;
    }

    const result = await request('pair.request') as { code: string };
    console.log(`\n  Pairing code: ${result.code}\n`);
    console.log('Enter this code in the extension popup to pair.');
    console.log('Code expires in 5 minutes.');
  });

program
  .command('unpair')
  .description('Remove stored remote server credentials')
  .action(async () => {
    const config = loadConfigFile();
    if (!config.token && !config.server) {
      console.log('No remote config to clear.');
      return;
    }
    if (config.token && config.name) {
      try {
        await request('token.revoke', { name: config.name });
        console.log('Server token revoked.');
      } catch {
        console.log('Could not reach server to revoke token (cleared locally only).');
      }
    }
    saveConfig({ token: undefined, server: undefined, name: undefined });
    console.log('Remote credentials cleared.');
  });

program
  .command('disable')
  .description('Disable extension (disconnect)')
  .action(async () => {
    await request('disable');
    console.log('Extension disabled');
  });

program
  .command('whitelist')
  .description('View whitelist (manage from popup)')
  .action(async () => {
    const result = await request('whitelist.get');
    out(result);
  });

program
  .command('clients')
  .description('List connected clients')
  .action(async () => {
    const result = await request('client.list') as Array<Record<string, unknown>>;
    for (const c of result) {
      const marker = c.active ? '*' : ' ';
      const paired = c.paired ? 'paired' : 'unpaired';
      console.log(`${marker} [${c.id}] ${c.name} (${paired})`);
    }
  });

program
  .command('switch <clientId>')
  .description('Switch active client')
  .action(async (clientId: string) => {
    await request('client.switch', { clientId });
    console.log(`Switched to client ${clientId}`);
  });

// --- server subcommand ---

const pidFile = path.join(STATE_DIR, 'server.pid');
const __cli_dirname = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.resolve(__cli_dirname, 'server.js');
const serverTs = path.resolve(__cli_dirname, 'server.ts');
const serverScript = fs.existsSync(serverJs) ? serverJs : serverTs;
const serverRuntime = serverScript.endsWith('.ts') ? 'bun' : 'node';

function getProcessCommandLine(pid: number): string | null {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ], { encoding: 'utf-8' });

    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  }

  const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!pid) return null;
    process.kill(pid, 0);
    const cmdline = getProcessCommandLine(pid);
    if (!cmdline) return null;
    if (!cmdline.includes('server')) return null;
    return pid;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

const serverCmd = program.command('server').description('Manage bridge server');

serverCmd
  .command('start')
  .description('Start bridge server in background')
  .option('--host <host>', 'Bind host', '127.0.0.1')
  .option('-p, --port <port>', 'Bind port', '52853')
  .option('--token <token>', 'Fixed server token')
  .action(async (opts) => {
    const existing = readPid();
    if (existing) {
      console.log(`Server already running (PID ${existing})`);
      return;
    }
    try {
      const probe = await fetch(`http://${opts.host}:${opts.port}/api/health`);
      if (probe.ok) {
        console.error(`Error: Port ${opts.port} already in use on ${opts.host}.`);
        console.error(`Try: npx browser-bridge-cli server start --port <other-port>`);
        process.exit(1);
      }
    } catch {}
    const args = [serverScript, '--host', opts.host, '--port', opts.port];
    if (opts.token) args.push('--token', opts.token);
    const child = spawn(serverRuntime, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.unref();
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const res = await fetch(`http://${opts.host}:${opts.port}/api/health`);
        if (res.ok) {
          child.stderr?.destroy();
          const pid = readPid() || child.pid;
          console.log(`Server started (PID ${pid})`);
          console.log(`Listening on http://${opts.host}:${opts.port}`);
          return;
        }
      } catch {}
    }
    child.stderr?.destroy();
    if (stderr.trim()) {
      console.error(`Failed to start server:\n${stderr.trim()}`);
    } else {
      console.error(`Failed to start server on http://${opts.host}:${opts.port}`);
      console.error('Check if the port is available or try a different port.');
    }
    process.exit(1);
  });

serverCmd
  .command('stop')
  .description('Stop bridge server')
  .action(() => {
    const pid = readPid();
    if (!pid) {
      console.log('Server is not running.');
      return;
    }
    process.kill(pid, 'SIGTERM');
    console.log(`Server stopped (PID ${pid})`);
  });

serverCmd
  .command('status')
  .description('Check if bridge server is running')
  .action(async () => {
    const pid = readPid();
    if (!pid) {
      console.log('Server is not running.');
      return;
    }
    const config = resolveConfig(program.opts());
    const isHealthy = await health();
    console.log(`Server running (PID ${pid})`);
    console.log(`URL: ${config.url}`);
    console.log(`Health: ${isHealthy ? 'ok' : 'unreachable'}`);
  });

serverCmd
  .command('gen-pair')
  .description('Generate a pairing code on the running server')
  .action(async () => {
    const result = await request('pair.request') as { code: string };
    console.log(`\n  Pairing code: ${result.code}\n`);
    console.log('Enter this code in the CLI or extension to pair.');
    console.log('Code expires in 5 minutes.');
  });

serverCmd
  .command('install-service')
  .description('Install as systemd user service (Linux)')
  .option('--host <host>', 'Bind host', '127.0.0.1')
  .option('-p, --port <port>', 'Bind port', '52853')
  .option('--token <token>', 'Fixed server token')
  .option('--uninstall', 'Remove the service')
  .action(async (opts) => {
    if (process.platform !== 'linux') {
      console.error('install-service is only supported on Linux (systemd).');
      process.exit(1);
    }
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const serviceFile = path.join(serviceDir, 'browser-bridge.service');

    if (opts.uninstall) {
      try { await run('systemctl', ['--user', 'stop', 'browser-bridge']); } catch {}
      try { await run('systemctl', ['--user', 'disable', 'browser-bridge']); } catch {}
      try { fs.unlinkSync(serviceFile); } catch {}
      try { await run('systemctl', ['--user', 'daemon-reload']); } catch {}
      console.log('Service uninstalled.');
      return;
    }

    const execArgs = [serverRuntime, serverScript, '--host', opts.host, '--port', opts.port];
    if (opts.token) execArgs.push('--token', opts.token);
    const escapedExecStart = execArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
    const escapedHome = os.homedir().includes(' ') ? `"${os.homedir()}"` : os.homedir();

    const unit = `[Unit]
Description=Browser Bridge Server
After=network.target

[Service]
Type=simple
ExecStart=${escapedExecStart}
Restart=on-failure
RestartSec=5
Environment=HOME=${escapedHome}

[Install]
WantedBy=default.target
`;

    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(serviceFile, unit);

    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', 'browser-bridge']);

    console.log('Service installed and started.');
    console.log(`  Config: ${serviceFile}`);
    console.log(`  Status: systemctl --user status browser-bridge`);
    console.log(`  Logs:   journalctl --user -u browser-bridge -f`);
  });

// --- config subcommand ---

const configCmd = program.command('config').description('Manage CLI configuration');

configCmd
  .command('get')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfigFile();
    if (Object.keys(config).length === 0) {
      console.log('No config set. Using defaults (local server).');
      return;
    }
    const masked = { ...config };
    if (masked.token) masked.token = masked.token.slice(0, 8) + '...';
    out(masked);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value (server, token, name)')
  .action((key: string, value: string) => {
    if (!['server', 'token', 'name'].includes(key)) {
      console.error(`Unknown config key: ${key}. Valid: server, token, name`);
      process.exit(1);
    }
    saveConfig({ [key]: value });
    const display = key === 'token' ? value.slice(0, 8) + '...' : value;
    console.log(`Set ${key} = ${display}`);
  });

configCmd
  .command('reset')
  .description('Clear all configuration')
  .action(() => {
    resetConfig();
    console.log('Config cleared.');
  });

const shareCmd = program.command('share').description('View and control a tab in an adaptive browser Canvas');

for (const action of ['start', 'links']) {
  const command = shareCmd.command(action)
    .description(action === 'start' ? 'Start sharing with all three viewer modes' : 'Get fixed-tab, active-tab and browser-viewer links');
  if (action === 'links') command.option('-t, --tab <id>', 'Fixed-tab link target (default: current tab)', Number);
  command
    .option('--client <id>', 'Fixed extension client ID (default: active client)')
    .option('--username <name>', 'HTTP login username (required for non-local listeners)')
    .option('--password-env <variable>', 'Environment variable holding the login password', 'BROWSER_BRIDGE_SHARE_PASSWORD')
    .addHelpText('after', '\nOpen or bookmark the printed permanent URL; no fragment or saved browser credentials are required.\nSupports click, drag, scroll, direct typing and IME input.\nRequires WebCodecs VP8, the updated extension, and a localhost or HTTPS viewer.\nReturns three links: fixed current tab, follow active tab, and selectable browser tabs.\nStable URLs survive service restarts on the Bridge port; definitions survive server restarts.\nOther CLI commands can run during sharing without --keep-attached.\nExamples:\n  browser-bridge-cli share start\n  browser-bridge-cli share links --tab 123\n  browser-bridge-cli share status \'http://127.0.0.1:52853/share/HASH/\'\n  browser-bridge-cli share stop \'http://127.0.0.1:52853/share/HASH/\'')
    .action(async opts => {
      await ensureServer();
      const config = resolveConfig(program.opts());
      let clientId: string | undefined;
      const call = async (action: string, params: Record<string, unknown> = {}) => {
        const res = await fetch(`${config.url}/api/execute`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Bridge': config.token },
          body: JSON.stringify({ action, params, clientId }), signal: AbortSignal.timeout(35000),
        });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.error || 'Bridge request failed');
        return result.data;
      };
      const clients = await call('client.list');
      const client = clients.find((c: any) => c.paired && (opts.client ? c.id === opts.client : c.active));
      if (!client) throw new Error('No matching connected extension client');
      clientId = client.id;
      const password = process.env[opts.passwordEnv];
      if (opts.username && !password) throw new Error('Missing password environment variable');
      if (opts.tab !== undefined && (!Number.isSafeInteger(opts.tab) || opts.tab < 0)) throw new Error('Invalid tab ID');
      const session = await call('share.' + action, { tabId: opts.tab, username: opts.username, password: opts.username ? password : undefined });
      out({ clientId: session.clientId, links: Object.fromEntries(Object.entries(session.links).map(([mode, link]: [string, any]) => [mode, { ...link, url: new URL(link.path, config.url).href }])) });
    });
}

for (const action of ['status', 'stop']) {
  shareCmd.command(`${action} <url>`)
    .description(`${action === 'status' ? 'Inspect' : 'Stop'} a share using its complete viewer URL`)
    .option('--username <name>', 'HTTP login username')
    .option('--password-env <variable>', 'Environment variable holding the login password', 'BROWSER_BRIDGE_SHARE_PASSWORD')
    .action(async (value: string, opts) => {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !/^\/share\/[a-f0-9]{24}\/$/.test(url.pathname)) throw new Error('Use the complete share URL');
      const password = process.env[opts.passwordEnv];
      if (opts.username && !password) throw new Error('Missing password environment variable');
      url.hash = ''; url.pathname += action; url.search = '';
      const headers: Record<string, string> = {};
      if (opts.username) headers.Authorization = 'Basic ' + Buffer.from(opts.username + ':' + password).toString('base64');
      const res = await fetch(url, { method: action === 'stop' ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(action === 'stop' ? 45000 : 10000), redirect: 'error' });
      if (!res.ok) throw new Error(`Share ${action} failed: HTTP ${res.status}`);
      out(await res.json());
    });
}

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
