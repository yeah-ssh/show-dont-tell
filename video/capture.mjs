#!/usr/bin/env node
// Films real product footage at 1920×1080 into video/raw/footage/<shot>.mp4.
// Two modes: a real-time screenshot loop (live interactions) and frame-stepped capture (smooth scrolls).
// Usage: node capture.mjs <shot> [args]   shots: see SHOTS at the bottom.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const OUT = join(here, 'raw', 'footage');
mkdirSync(OUT, { recursive: true });
const TF = process.env.TRUEFORGE_URL || 'http://localhost:8790';
const LINEAR_PROFILE = process.env.LINEAR_PROFILE_DIR;
const FPS = 30;
const W = 1920;
const H = 1080;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A visible cursor with a click ripple (headless screenshots don't show the mouse).
const CURSOR_SCRIPT = `
(() => {
  const mount = () => {
    if (document.getElementById('__cur')) return;
    const s = document.createElement('style');
    s.textContent = '#__cur{position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .08s}' +
      '#__cur svg{filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))}' +
      '.__rip{position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid #7c6cff;pointer-events:none;animation:__r .6s ease-out forwards}' +
      '@keyframes __r{to{transform:scale(4);opacity:0}}';
    document.documentElement.appendChild(s);
    const c = document.createElement('div');
    c.id = '__cur';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.4-7.6L20.5 11z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    c.style.transform = 'translate(-100px,-100px)';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', e => { c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
    addEventListener('mousedown', e => {
      const r = document.createElement('div'); r.className = '__rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
      c.style.transform += ' scale(.85)'; setTimeout(() => { c.style.transform = c.style.transform.replace(' scale(.85)', ''); }, 120);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();`;

async function openBrowser({ linear = false } = {}) {
  if (linear) {
    if (!LINEAR_PROFILE) throw new Error('LINEAR_PROFILE_DIR is required for Linear shots');
    const ctx = await chromium.launchPersistentContext(LINEAR_PROFILE, {
      headless: true,
      channel: 'chrome',
      viewport: { width: W, height: H },
      colorScheme: 'dark',
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'],
    });
    await ctx.addInitScript(CURSOR_SCRIPT);
    return { ctx, page: ctx.pages()[0] ?? (await ctx.newPage()), close: () => ctx.close() };
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark' });
  await ctx.addInitScript(CURSOR_SCRIPT);
  return { ctx, page: await ctx.newPage(), close: () => browser.close() };
}

// Real-time recorder: screenshots as fast as the page allows, timestamped, assembled to constant 30 fps.
class Recorder {
  constructor(page, name) {
    this.page = page;
    this.name = name;
    this.dir = join(OUT, `${name}.frames`);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.markers = {};
  }
  start() {
    this.t0 = Date.now();
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const file = join(this.dir, `f${String(this.frames.length).padStart(6, '0')}.jpg`);
        const t = Date.now();
        try {
          await this.page.screenshot({ type: 'jpeg', quality: 86, path: file });
          this.frames.push({ file, t: t - this.t0 });
        } catch {
          await sleep(100);
        }
      }
    })();
    return this;
  }
  mark(label) {
    this.markers[label] = (Date.now() - this.t0) / 1000;
    console.log(`  ⏱ ${label} @ ${this.markers[label].toFixed(1)}s`);
  }
  async stop() {
    this.running = false;
    await this.loop;
    const total = (Date.now() - this.t0) / 1000;
    const list = this.frames
      .map((f, i) => {
        const next = this.frames[i + 1]?.t ?? total * 1000;
        return `file '${f.file}'\nduration ${((next - f.t) / 1000).toFixed(4)}`;
      })
      .join('\n');
    const listFile = join(this.dir, 'list.txt');
    writeFileSync(listFile, `${list}\nfile '${this.frames.at(-1).file}'\n`);
    const out = join(OUT, `${this.name}.mp4`);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', out,
    ]);
    writeFileSync(join(OUT, `${this.name}.markers.json`), JSON.stringify({ duration: total, markers: this.markers }, null, 2));
    rmSync(this.dir, { recursive: true, force: true });
    console.log(`✓ ${this.name}.mp4  ${total.toFixed(1)}s, ${this.frames.length} frames (${(this.frames.length / total).toFixed(1)} fps captured)`);
  }
}

// Frame-stepped capture: `step(t)` sets the page state for time t; perfectly smooth output.
async function stepped(page, name, seconds, step) {
  const dir = join(OUT, `${name}.frames`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    await step(i / FPS, i / Math.max(1, n - 1));
    await page.screenshot({ type: 'jpeg', quality: 90, path: join(dir, `f${String(i).padStart(5, '0')}.jpg`) });
  }
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'medium', join(OUT, `${name}.mp4`),
  ]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`✓ ${name}.mp4  ${seconds}s stepped`);
}

const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// Scroll the main scrollable element (or window) to a fraction of its height, eased over the shot.
async function scrollTo(page, fraction, selector) {
  await page.evaluate(
    ({ fraction, selector }) => {
      const pick = () => {
        if (selector) return document.querySelector(selector);
        const all = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
        all.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
        return all[0] || document.scrollingElement;
      };
      const el = (window.__scrollEl ||= pick());
      el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
    },
    { fraction, selector },
  );
}

async function moveMouse(page, from, to, ms = 700) {
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const k = ease(i / steps);
    await page.mouse.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    await sleep(ms / steps);
  }
  return to;
}

async function centerOf(locator) {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}


// Films a TrueForge session page until the run finishes: optionally types the first message,
// and clicks each approval (Allow) on camera after giving the viewer time to read the card.
async function filmSession(sessionId, name, issue) {
    const { page, close } = await openBrowser();
    await page.goto(`${TF}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const rec = new Recorder(page, name).start();
    let cur = { x: 1500, y: 700 };
    if (issue) {
      const box = page.getByPlaceholder(/Ask anything/i).last();
      cur = await moveMouse(page, cur, await centerOf(box), 1000);
      await box.click();
      await page.keyboard.type(`Resolve Linear issue ${issue}.`, { delay: 55 });
      await sleep(500);
      rec.mark('send');
      await page.keyboard.press('Enter');
    }

    const approved = new Set();
    const deadline = Date.now() + 15 * 60_000;
    let idleSince = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      const btn = page.locator('button', { hasText: /^\s*(Approve|Allow)\s*$/ }).first();
      if ((await btn.count()) && (await btn.isVisible())) {
        const label = (await page.evaluate(() => document.body.innerText.match(/(create_pull_request|send_customer_reply)/g)?.at(-1))) ?? 'approval';
        if (!approved.has(label)) {
          await btn.scrollIntoViewIfNeeded();
          await sleep(2200); // let the viewer read the approval card
          rec.mark(`approve:${label}`);
          cur = await moveMouse(page, cur, await centerOf(btn), 900);
          await sleep(500);
          await btn.click();
          approved.add(label);
          await sleep(1500);
          continue;
        }
      }
      // Turns are listed oldest-first; the newest one is last.
      const turns = await fetch(`${TF}/api/v1/sessions/${sessionId}/turns?limit=100`).then(r => r.json());
      const st = turns.data?.at(-1)?.state;
      const done = st?.status === 'done' && !(st.required_actions ?? []).length;
      if (done && approved.size >= 2) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince > 6000) break;
      }
    }
    rec.mark('done');
    await rec.stop();
    await close();
}

// ---------------------------------------------------------------------------------------------
const SHOTS = {
  // Linear: the team's issue list, then open the ticket.
  async 'linear-ticket'(issue) {
    const { page, close } = await openBrowser({ linear: true });
    await page.goto('https://linear.app/trueforge/team/TRU/all', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const rec = new Recorder(page, 'linear-ticket').start();
    let cur = await moveMouse(page, { x: 1500, y: 900 }, { x: 1200, y: 700 }, 900);
    await sleep(1200);
    const row = page.getByText(issue, { exact: true }).first();
    if (await row.count()) {
      cur = await moveMouse(page, cur, await centerOf(row), 1100);
      await sleep(400);
      rec.mark('open');
      await page.mouse.down();
      await page.mouse.up();
      await row.click().catch(() => {});
    } else {
      await page.goto(`https://linear.app/trueforge/issue/${issue}`);
    }
    await sleep(6500);
    rec.mark('ticket');
    await moveMouse(page, cur, { x: 1300, y: 420 }, 1500);
    await sleep(2500);
    await rec.stop();
    await close();
  },

  // Linear after the run: the agent's notes and the approved reply on the ticket.
  async 'linear-after'(issue, name = 'linear-after', from = '0', to = '1') {
    const { page, close } = await openBrowser({ linear: true });
    await page.goto(`https://linear.app/trueforge/issue/${issue}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    const a = Number(from);
    const b = Number(to);
    await stepped(page, name, 9, async (t, p) => scrollTo(page, a + (b - a) * ease(Math.min(1, p * 1.15))));
    await close();
  },

  // A finished TrueForge session, scrolled top → bottom (verdict at the end).
  async session(sessionId, name = 'session', seconds = '10', from = '0', to = '1') {
    const { page, close } = await openBrowser();
    await page.goto(`${TF}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3500);
    const a = Number(from);
    const b = Number(to);
    await stepped(page, name, Number(seconds), async (t, p) => scrollTo(page, a + (b - a) * ease(p)));
    await close();
  },

  // Schedules page: hold, hover the sweep and its Run now control.
  async schedules() {
    const { page, close } = await openBrowser();
    await page.goto(`${TF}/schedules`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const rec = new Recorder(page, 'schedules').start();
    let cur = await moveMouse(page, { x: 1600, y: 950 }, { x: 900, y: 500 }, 900);
    await sleep(800);
    const row = page.getByText('bug-triage-sweep').first();
    if (await row.count()) cur = await moveMouse(page, cur, await centerOf(row), 1000);
    await sleep(1200);
    const run = page.getByRole('button', { name: /run now/i }).first();
    if (await run.count()) {
      cur = await moveMouse(page, cur, await centerOf(run), 900);
      await sleep(1800);
    }
    await sleep(1500);
    await rec.stop();
    await close();
  },

  // GitHub PR page: title → evidence GIF → verification list.
  async pr(number, seconds = '12') {
    const { page, close } = await openBrowser();
    await page.goto(`https://github.com/yeah-ssh/demo-shop/pull/${number}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);
    await page.evaluate(() => { window.__scrollEl = document.scrollingElement; });
    const max = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    const target = Math.min(1, 1500 / Math.max(1, max));
    await stepped(page, 'pr', Number(seconds), async (t, p) => scrollTo(page, target * ease(Math.min(1, p * 1.1))));
    await close();
  },

  // The demo store (served by the lab's target repo checkout).
  async store(url = 'http://127.0.0.1:5099') {
    const { page, close } = await openBrowser();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const rec = new Recorder(page, 'store').start();
    let cur = await moveMouse(page, { x: 1700, y: 900 }, { x: 700, y: 420 }, 900);
    const add = page.locator('[data-add="tee"]');
    cur = await moveMouse(page, cur, await centerOf(add), 900);
    await add.click();
    await sleep(900);
    await page.evaluate(() => document.getElementById('cart').scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(1500);
    const co = page.locator('#checkout');
    cur = await moveMouse(page, cur, await centerOf(co), 900);
    await sleep(1500);
    await rec.stop();
    await close();
  },

  // Resume filming an existing live session (e.g. to click its pending approvals on camera).
  async 'live-resume'(sessionId, name = 'live2') {
    return filmSession(sessionId, name, null);
  },

  // Live: open a fresh TrueForge session, type the ticket, film the whole run, click approvals on camera.
  async live(issue) {
    const { TrueForge } = await import('@truefoundry/trueforge-sdk');
    const client = new TrueForge({ baseUrl: TF, timeoutInSeconds: 60 });
    const { data: session } = await client.sessions.create({ agent: { name: 'ticket-resolver' }, metadata: { linear_issue: issue, video: 'launch' } });
    await client.sessions.update(session.id, { title: `${issue}: launch video` });
    console.log(`session ${TF}/sessions/${session.id}`);
    writeFileSync(join(OUT, 'live.session.txt'), session.id);

    await filmSession(session.id, 'live', issue);
  },
};

const [shot, ...args] = process.argv.slice(2);
if (!SHOTS[shot]) {
  console.error(`usage: node capture.mjs <${Object.keys(SHOTS).join('|')}> [args]`);
  process.exit(1);
}
await SHOTS[shot](...args);
