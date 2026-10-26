/** Calendar toolbar: real translations and navigation glyphs without SVG rendering. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { launchBrowser } from '../scripts/lib/chrome-executable.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const sheets = [...readFileSync(join(PUBLIC, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
  .map((match) => match[1]);
const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<link rel="stylesheet" href="/styles/calendar.css">
</head><body><main id="main-content" class="app-content">
<div class="calendar-page app-page app-page--full" id="calendar-page">
<div class="page-toolbar page-toolbar--wrap page-toolbar--period page-toolbar--period-title cal-toolbar" id="cal-toolbar"></div>
</div></main></body></html>`;
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
let browser;
let page;

before(async () => {
  browser = await launchBrowser(puppeteer, { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/probe') return request.respond({ status: 200, contentType: 'text/html', body: HTML });
    const file = join(PUBLIC, pathname);
    if (!existsSync(file) || statSync(file).isDirectory()) return request.respond({ status: 404, body: '' });
    return request.respond({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://calendar-toolbar.local/probe', { waitUntil: 'load' });
  await page.evaluate(async () => {
    localStorage.setItem('yuvomi-locale', 'zh');
    await (await import('/i18n.js')).initI18n();
  });
});

after(async () => { await browser?.close(); });

async function mount(view, { away = false, rtl = false } = {}) {
  await page.evaluate(async ({ view, away, rtl }) => {
    const calendar = (await import('/pages/calendar.js')).__test;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    Object.assign(calendar.state, { view, cursor: '2026-09-21', today: away ? '2026-10-26' : '2026-09-21' });
    const bar = document.getElementById('cal-toolbar');
    bar.replaceChildren();
    bar.insertAdjacentHTML('beforeend', calendar.toolbarHtml());
    calendar.setContainerForTest(document.getElementById('main-content'));
    calendar.updateLabel();
    calendar.syncToolbarFit(bar);
    window.toolbarClicks = [];
    for (const id of ['cal-prev', 'cal-next']) {
      document.getElementById(id).addEventListener('click', () => window.toolbarClicks.push(id));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { view, away, rtl });
}

async function arrow(selector) {
  return page.$eval(selector, (button) => {
    const box = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const glyph = getComputedStyle(button, '::before');
    const matrix = new DOMMatrix(glyph.transform);
    const cornerX = glyph.direction === 'rtl' ? 1 : -1;
    const tipX = matrix.a * cornerX + matrix.c;
    const tipY = matrix.b * cornerX + matrix.d;
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      visible: box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility === 'visible',
      hit: hit === button || button.contains(hit),
      glyph: glyph.content === '""' && parseFloat(glyph.width) > 0 && parseFloat(glyph.height) > 0
        && parseFloat(glyph.borderInlineStartWidth) > 0 && parseFloat(glyph.borderBlockEndWidth) > 0,
      pointsRight: tipX > 0,
      horizontal: Math.abs(tipY) < 0.01,
      name: button.getAttribute('aria-label'),
    };
  });
}

test('desktop week uses the real Chinese translation without an unresolved year', async () => {
  await page.setViewport({ width: 1440, height: 900 });
  await mount('week');
  assert.equal(await page.$eval('#cal-label', (label) => label.textContent), '第 39 周 · 九月');
});

test('both arrows remain drawn and clickable without any SVG, in every view and reset state', async () => {
  for (const width of [1440, 1280, 834, 390]) {
    await page.setViewport({ width, height: 900 });
    for (const view of ['month', 'week', 'day', 'agenda']) {
      for (const away of [false, true]) {
        await mount(view, { away });
        await page.evaluate(() => document.querySelectorAll('#cal-prev > i, #cal-next > i, #cal-prev > svg, #cal-next > svg')
          .forEach((icon) => icon.remove()));
        for (const selector of ['#cal-prev', '#cal-next']) {
          const result = await arrow(selector);
          assert.ok(result.visible && result.hit && result.glyph && result.name,
            `${width}px ${view} away=${away} ${selector}: ${JSON.stringify(result)}`);
          await page.click(selector);
        }
        assert.deepEqual(await page.evaluate(() => window.toolbarClicks), ['cal-prev', 'cal-next']);
      }
    }
  }
});

test('right-to-left navigation mirrors both chevrons', async () => {
  await page.setViewport({ width: 1440, height: 900 });
  await mount('month');
  const ltr = [await arrow('#cal-prev'), await arrow('#cal-next')];
  await mount('month', { rtl: true });
  const rtl = [await arrow('#cal-prev'), await arrow('#cal-next')];
  assert.equal(ltr[0].pointsRight, false);
  assert.equal(ltr[1].pointsRight, true);
  assert.equal(rtl[0].pointsRight, true);
  assert.equal(rtl[1].pointsRight, false);
  assert.ok([...ltr, ...rtl].every((item) => item.visible && item.hit && item.glyph && item.horizontal));
});
