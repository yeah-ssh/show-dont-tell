// Smoke test for the browser-lab MCP server: BEFORE/AFTER on the mobile checkout bug.
// Usage: node scripts/lab-smoke.mjs [http://127.0.0.1:8900/mcp]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || 'http://127.0.0.1:8900/mcp';
const client = new Client({ name: 'lab-smoke', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const out = JSON.parse(res.content[0].text.replace(/^Error: /, '"') + (res.isError ? '"' : ''));
  console.log(`\n== ${name}\n`, out);
  return out;
};

console.log('tools:', (await client.listTools()).tools.map(t => t.name).join(', '));
const script = `
await page.locator('[data-add="tee"]').click();
await expect(page.locator('#checkout')).toBeVisible();
await page.locator('#checkout').click();
await expect(page.locator('#checkout-message')).toHaveText('Order placed! (demo)');`;
const patch = `diff --git a/static/styles.css b/static/styles.css
--- a/static/styles.css
+++ b/static/styles.css
@@ -97,8 +97,7 @@
 /* Compact header on small screens: collapse the nav to save space. */
 @media (max-width: 480px) {
   .site-header { padding: 12px 16px; }
-  .header-actions,
-  .checkout-btn {
+  .header-actions {
     display: none;
   }
   main { padding: 16px; }
`;
const desk = await call('run_repro', { script, viewport: 'desktop', label: 'desktop' });
const before = await call('run_repro', { script, viewport: 'mobile', label: 'BEFORE mobile' });
const after = await call('run_repro', { script, viewport: 'mobile', label: 'AFTER mobile', patch });
await call('compose_evidence', {
  title: 'Checkout button on mobile: before vs after',
  panels: [
    { run_id: before.run_id, label: 'BEFORE: bug', tone: 'bad' },
    { run_id: after.run_id, label: 'AFTER: fixed', tone: 'good' },
  ],
});
await client.close();
