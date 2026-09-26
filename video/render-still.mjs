#!/usr/bin/env node
// Renders a scene page as a single PNG (optionally transparent), e.g. captions, frames, masks.
// Usage: node render-still.mjs <scene> <out.png> [jsonParams] [--transparent]
// Also usable as a module: renderStills([{ scene, out, params, transparent }]) reuses one browser.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

export async function renderStills(jobs) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const job of jobs) {
    const url = pathToFileURL(join(here, 'scenes', `${job.scene}.html`));
    url.search = `?n=${jobs.indexOf(job)}`; // a hash-only change wouldn't reload the page
    url.hash = encodeURIComponent(JSON.stringify(job.params ?? {}));
    await page.goto(url.href, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.ready?.();
    });
    await page.screenshot({ path: job.out, omitBackground: Boolean(job.transparent) });
  }
  await browser.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [scene, out, params, flag] = process.argv.slice(2);
  await renderStills([{ scene, out, params: params ? JSON.parse(params) : {}, transparent: flag === '--transparent' }]);
  console.log(`✓ ${out}`);
}
