#!/usr/bin/env node
// Renders an HTML motion-graphics scene to mp4, frame-accurately.
// Each scene page exposes window.build(duration) → a paused GSAP timeline; we seek it frame by frame
// and pipe screenshots into ffmpeg. Usage: node render-scene.mjs <scene> <seconds> <out.mp4> [jsonParams]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const [scene, secondsArg, out, paramsArg] = process.argv.slice(2);
if (!scene || !secondsArg || !out) {
  console.error('usage: node render-scene.mjs <scene> <seconds> <out.mp4> [jsonParams]');
  process.exit(1);
}
const FPS = 30;
const duration = Number(secondsArg);
const frames = Math.round(duration * FPS);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const url = pathToFileURL(join(here, 'scenes', `${scene}.html`));
if (paramsArg) url.hash = encodeURIComponent(paramsArg);
await page.goto(url.href, { waitUntil: 'load' });
await page.evaluate(async d => {
  await document.fonts.ready;
  window.__tl = window.build(d);
  window.__tl.pause(0);
}, duration);

// Frames go to disk first: piping screenshots straight into a spawned ffmpeg deadlocked Playwright.
const frameDir = mkdtempSync(join(tmpdir(), `scene-${scene}-`));
for (let i = 0; i < frames; i++) {
  await page.evaluate(t => { window.__tl.seek(t, false); }, i / FPS); // return nothing: a timeline is not serializable
  await page.screenshot({ type: 'jpeg', quality: 95, path: join(frameDir, `f${String(i).padStart(5, '0')}.jpg`) });
}
await browser.close();
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frameDir, 'f%05d.jpg'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', '-r', String(FPS), out,
]);
rmSync(frameDir, { recursive: true, force: true });
console.log(`✓ ${scene} → ${out} (${frames} frames)`);
