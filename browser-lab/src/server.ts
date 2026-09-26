import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config.js';
import { composePanels } from './evidence.js';
import { sendCustomerReply } from './reply.js';
import { executeRun, loadRun } from './runs.js';
import { verifyScreens } from './vision.js';

const VIEWPORTS = {
  desktop: { width: 1280, height: 720, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
  tablet: { width: 820, height: 1180, mobile: true },
} as const;

async function audit(tool: string, args: unknown, result: unknown): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), tool, args, result });
  await appendFile(join(config.dataDir, 'audit.jsonl'), `${line}\n`);
}

function reply(tool: string, args: unknown, result: unknown) {
  void audit(tool, args, result);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

function fail(tool: string, args: unknown, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  void audit(tool, args, { error: message });
  return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'browser-lab', version: '0.1.0' });

  server.registerTool(
    'run_repro',
    {
      title: 'Run a browser reproduction',
      description:
        'Runs a Playwright check against a fresh copy of the target app in an isolated browser lab and records a video. ' +
        '`script` is the BODY of an async function with (page, expect, baseURL) in scope; the page has already loaded the home page. ' +
        'Write the script to assert the CORRECT behaviour the customer expects (e.g. `await expect(page.locator("#checkout")).toBeVisible()`). ' +
        'outcome "failed" means the assertion failed, i.e. the bug is reproduced; "passed" means the app behaved correctly. ' +
        'Pass `patch` (a unified diff from `git diff`, relative to the repo root) to test a fix: the same script should then pass. ' +
        'The lab only reaches the app itself; outside requests are blocked.',
      inputSchema: {
        script: z.string().min(1).describe('Body of an async function (page, expect, baseURL). No imports.'),
        browser: z.enum(['chromium', 'firefox']).default('chromium'),
        viewport: z.enum(['desktop', 'mobile', 'tablet']).default('desktop').describe('desktop 1280x720, mobile 390x844 (touch), tablet 820x1180'),
        patch: z.string().optional().describe('Unified diff to apply before running (omit for the unpatched BEFORE run).'),
        label: z.string().default('attempt').describe('Short caption, e.g. "BEFORE mobile" or "AFTER mobile".'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async args => {
      try {
        const vp = VIEWPORTS[args.viewport];
        const meta = await executeRun({
          script: args.script,
          patch: args.patch,
          browser: args.browser,
          viewport: { width: vp.width, height: vp.height },
          mobile: vp.mobile,
          label: args.label,
        });
        const { video_path, screenshot_path, ...visible } = meta;
        return reply('run_repro', { ...args, script: `${args.script.length} chars`, patch: args.patch ? `${args.patch.length} chars` : undefined }, visible);
      } catch (err) {
        return fail('run_repro', args, err);
      }
    },
  );

  server.registerTool(
    'compose_evidence',
    {
      title: 'Compose video evidence',
      description:
        'Combines 1 to 3 recorded runs into one captioned side-by-side video (mp4) plus an animated GIF preview, and publishes both. ' +
        'Use tone "bad" for the run showing the bug, "good" for the fixed run, "neutral" for attempts that did not reproduce. ' +
        'Returns URLs and a ready-to-paste markdown snippet.',
      inputSchema: {
        title: z.string().describe('e.g. "ACME-1: checkout button on mobile — before vs after"'),
        panels: z
          .array(z.object({ run_id: z.string(), label: z.string(), tone: z.enum(['bad', 'good', 'neutral']) }))
          .min(1)
          .max(3),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async args => {
      try {
        const panels = await Promise.all(args.panels.map(async p => ({ ...p, run: await loadRun(p.run_id) })));
        return reply('compose_evidence', args, await composePanels(panels, args.title));
      } catch (err) {
        return fail('compose_evidence', args, err);
      }
    },
  );

  server.registerTool(
    'verify_screens',
    {
      title: 'Vision double-check',
      description:
        'Independent check by a vision model: looks at the final screenshots of the BEFORE and/or AFTER runs and judges whether the bug is visible ' +
        'and whether the fix resolves it. Use it to back up the DOM assertion with a confidence score.',
      inputSchema: {
        expectation: z.string().describe('The correct behaviour, in plain words, e.g. "The orange Checkout button is visible below the totals."'),
        before_run_id: z.string().optional(),
        after_run_id: z.string().optional(),
        ticket: z.string().optional().describe('Linear issue id, e.g. "TRU-5" (used for cost attribution in the AI gateway).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const before = args.before_run_id ? await loadRun(args.before_run_id) : undefined;
        const after = args.after_run_id ? await loadRun(args.after_run_id) : undefined;
        return reply('verify_screens', args, await verifyScreens({ expectation: args.expectation, before, after, ticket: args.ticket }));
      } catch (err) {
        return fail('verify_screens', args, err);
      }
    },
  );

  server.registerTool(
    'send_customer_reply',
    {
      title: 'Send reply to customer (irreversible)',
      description:
        'Emails the customer and posts the same reply publicly on the Linear issue. THIS CANNOT BE UNSENT. ' +
        'Call it directly with the final draft: the harness pauses and shows the draft to a human, who approves or denies it. ' +
        'Never ask for permission in chat instead of calling this tool.',
      inputSchema: {
        issue_id: z.string().describe('Linear issue identifier, e.g. "DEM-1"'),
        to_email: z.string().email(),
        subject: z.string(),
        body_markdown: z.string().describe('The full reply. Include the evidence GIF/video links.'),
        evidence_urls: z.array(z.string()).default([]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async args => {
      try {
        return reply('send_customer_reply', args, await sendCustomerReply(args));
      } catch (err) {
        return fail('send_customer_reply', args, err);
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, runner: config.runner, evidence: config.evidenceStore, target: config.targetRepo, model_route: config.viaGateway ? 'truefoundry-gateway' : 'openai' });
});
app.use('/evidence', express.static(config.dataDir));

// Stateless streamable HTTP: a fresh server + transport per request.
app.post('/mcp', async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all('/mcp', (_req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

app.listen(config.port, config.host, () => {
  console.log(`browser-lab MCP on http://${config.host}:${config.port}/mcp  (runner=${config.runner}, evidence=${config.evidenceStore})`);
});
