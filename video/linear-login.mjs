// Opens a visible browser with a persistent profile so the user can sign in to Linear once.
// The profile (cookies) lives in LINEAR_PROFILE_DIR, outside the repo; capture.mjs reuses it.
import { chromium } from '@playwright/test';

const profile = process.env.LINEAR_PROFILE_DIR;
if (!profile) throw new Error('set LINEAR_PROFILE_DIR');
// Real Chrome without automation flags: Google refuses sign-in from automation-controlled browsers.
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: 'chrome',
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://linear.app/login');
console.log('Waiting for Linear sign-in...');
await page.waitForURL(/linear\.app\/trueforge\//, { timeout: 30 * 60_000 });
console.log('SIGNED_IN');
await page.waitForTimeout(3000);
await ctx.close();
