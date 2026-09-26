// Linear webhook → TrueForge session. Adding the `agent-resolve` label to an issue starts the agent.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const envFile = resolve(import.meta.dirname, '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.DISPATCHER_PORT || 8910);
const SECRET = process.env.LINEAR_WEBHOOK_SECRET || '';
const TRIGGER_LABEL = process.env.TRIGGER_LABEL || 'agent-resolve';
const AGENT = process.env.AGENT_NAME || 'ticket-resolver';
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_URL || 'http://localhost:8790', timeoutInSeconds: 60 });

type LinearPayload = {
  action: string;
  type: string;
  webhookTimestamp: number;
  data: { id: string; identifier?: string; title?: string; labels?: { name: string }[]; labelIds?: string[] };
  updatedFrom?: { labelIds?: string[] };
};

function verify(raw: Buffer, signature: string | undefined): boolean {
  if (!SECRET) return true; // local testing without a secret
  if (!signature) return false;
  const expected = createHmac('sha256', SECRET).update(raw).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function labelJustAdded(p: LinearPayload): boolean {
  const names = (p.data.labels ?? []).map(l => l.name.toLowerCase());
  if (!names.includes(TRIGGER_LABEL)) return false;
  if (p.action === 'create') return true;
  // On updates, only fire when the label set changed (not on every edit of a labelled issue).
  return p.action === 'update' && p.updatedFrom?.labelIds !== undefined;
}

async function startSession(identifier: string, title: string) {
  // One session per ticket: Linear retries webhooks, so this must be idempotent.
  const existing = await client.sessions.list({ metadata: { linear_issue: identifier }, limit: 1 });
  if (existing.data.length) {
    console.log(`[${identifier}] session ${existing.data[0].id} already exists, skipping`);
    return;
  }
  const { data: session } = await client.sessions.create({
    agent: { name: AGENT },
    metadata: { linear_issue: identifier },
  });
  await client.sessions.update(session.id, { title: `${identifier}: ${title}` });
  console.log(`[${identifier}] session ${session.id} started`);
  const { data: turn } = await client.sessions.createTurn(session.id, {
    input: [{ type: 'user.message', content: `Resolve Linear issue ${identifier} ("${title}").` }],
  });
  console.log(`[${identifier}] turn ${turn.id} → ${process.env.TRUEFORGE_URL || 'http://localhost:8790'}`);
}

const app = express();
app.post('/linear-webhook', express.raw({ type: '*/*' }), (req, res) => {
  const raw = req.body as Buffer;
  if (!verify(raw, req.header('linear-signature'))) return res.status(401).send('bad signature');
  const payload = JSON.parse(raw.toString('utf8')) as LinearPayload;
  if (Math.abs(Date.now() - payload.webhookTimestamp) > 60_000) return res.status(401).send('stale');
  res.sendStatus(200); // Linear wants a fast 200; do the work after responding.

  if (payload.type !== 'Issue' || !labelJustAdded(payload)) return;
  const identifier = payload.data.identifier ?? payload.data.id;
  startSession(identifier, payload.data.title ?? '').catch(err => console.error(`[${identifier}]`, err));
});
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});
app.listen(PORT, () => console.log(`dispatcher on http://localhost:${PORT}/linear-webhook (label "${TRIGGER_LABEL}" → agent "${AGENT}")`));
