// Executes one agent-written Playwright check and records it.
// Input (stdin JSON): { script, browser, viewport, baseURL, outDir, mobile }
// Output: <outDir>/result.json, video.webm, final.png
//
// Contract for `script`: the body of an async function receiving (page, expect, baseURL).
// It should assert the CORRECT behaviour described in the ticket. If an assertion fails,
// the bug is reproduced. The page has already loaded baseURL when the script starts.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';

const cfg = JSON.parse(readFileSync(0, 'utf8'));
const stripAnsi = s => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const result = {
  outcome: 'passed',
  error: null,
  console_errors: [],
  page_errors: [],
  blocked_requests: [],
  browser: cfg.browser,
  viewport: cfg.viewport,
};

const AsyncFunction = (async () => {}).constructor;
let check;
try {
  check = new AsyncFunction('page', 'expect', 'baseURL', cfg.script);
} catch (err) {
  result.outcome = 'script_error';
  result.error = { name: err.name, message: stripAnsi(err.message) };
  writeFileSync(join(cfg.outDir, 'result.json'), JSON.stringify(result, null, 2));
  process.exit(0);
}

const browserType = { chromium, firefox }[cfg.browser];
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext({
  viewport: cfg.viewport,
  recordVideo: { dir: cfg.outDir, size: cfg.viewport },
  ...(cfg.mobile && cfg.browser === 'chromium' ? { isMobile: true, hasTouch: true } : {}),
});
context.setDefaultTimeout(5000);

// Only the app under test is reachable; everything else is blocked and reported.
const allowedOrigin = new URL(cfg.baseURL).origin;
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(allowedOrigin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  result.blocked_requests.push(url);
  return route.abort();
});

const page = await context.newPage();
page.on('console', msg => {
  if (msg.type() === 'error') result.console_errors.push(msg.text().slice(0, 500));
});
page.on('pageerror', err => result.page_errors.push(stripAnsi(err.message).slice(0, 500)));

try {
  await page.goto(cfg.baseURL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await check(page, expect, cfg.baseURL);
} catch (err) {
  result.outcome = 'failed';
  result.error = {
    name: err.name,
    message: stripAnsi(err.message).slice(0, 2500),
    is_assertion: Boolean(err.matcherResult) || /expect\(/.test(String(err.message)),
  };
  // Point the camera at the failure: scroll to the element (or its nearest rendered
  // ancestor, if the element itself is hidden) and circle it, so the video shows the bug.
  const selector = stripAnsi(err.message).match(/locator\('((?:[^'\\]|\\.)+)'\)/)?.[1];
  if (selector) {
    await page
      .evaluate(({ selector, note }) => {
        let el = document.querySelector(selector);
        const expectedEl = el;
        while (el && el.getClientRects().length === 0) el = el.parentElement;
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const ring = document.createElement('div');
        Object.assign(ring.style, {
          position: 'fixed', left: `${r.left - 6}px`, top: `${r.top - 6}px`,
          width: `${r.width + 12}px`, height: `${r.height + 12}px`,
          border: '4px dashed #d7263d', borderRadius: '10px', zIndex: 99999, pointerEvents: 'none',
        });
        const tag = document.createElement('div');
        tag.textContent = expectedEl === el ? note : `${note} (inside here)`;
        Object.assign(tag.style, {
          position: 'fixed', left: `${Math.max(r.left - 6, 4)}px`, top: `${Math.max(r.top - 34, 4)}px`,
          background: '#d7263d', color: '#fff', font: '600 13px -apple-system,Helvetica,sans-serif',
          padding: '4px 8px', borderRadius: '6px', zIndex: 99999, pointerEvents: 'none',
        });
        document.body.append(ring, tag);
      }, { selector, note: `✗ ${selector}: ${result.error.message.match(/Expected: (.*)/)?.[1] ?? 'check failed'}` })
      .catch(() => {});
  }
}

// Hold the final state for a moment so the video ends on the evidence.
await page.waitForTimeout(1200).catch(() => {});
await page.screenshot({ path: join(cfg.outDir, 'final.png') }).catch(() => {});
const video = page.video();
await context.close();
if (video) await video.saveAs(join(cfg.outDir, 'video.webm')).catch(() => {});
await browser.close();

writeFileSync(join(cfg.outDir, 'result.json'), JSON.stringify(result, null, 2));
