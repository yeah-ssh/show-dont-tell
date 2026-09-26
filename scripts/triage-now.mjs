#!/usr/bin/env node
// "Run now" for the auto-triage schedule: the terminal equivalent of the button in TrueForge → Schedules.
// Usage: node scripts/triage-now.mjs

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const TF = process.env.TRUEFORGE_URL || 'http://localhost:8790';

async function call(method, path, body) {
  const res = await fetch(`${TF}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const schedule = (await call('GET', '/api/v1/schedules')).data?.find(s => s.name === 'bug-triage-sweep');
if (!schedule) {
  console.error('No "bug-triage-sweep" schedule. Run: node scripts/bootstrap.mjs');
  process.exit(1);
}
const run = (await call('POST', '/api/v1/schedules/runs', { schedule_id: schedule.id })).data;
console.log(`Triggered ${schedule.name} (${schedule.manifest.cron} ${schedule.manifest.timezone}, ${schedule.manifest.status})`);
console.log(`run ${run?.id ?? ''}: ${run?.status ?? 'triggered'}`);

// Each run starts its own session ("Scheduled run"); find it and print the link.
for (let i = 0; i < 20; i++) {
  const runs = (await call('GET', `/api/v1/schedules/${schedule.id}/runs`)).data ?? [];
  const latest = runs.find(r => r.id === run?.id) ?? runs[0];
  if (latest?.session_id) {
    console.log(`session → ${TF}/sessions/${latest.session_id}`);
    process.exit(0);
  }
  if (latest?.status === 'failed') {
    console.error(`run failed: ${latest.reason}`);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 1500));
}
console.log(`Open ${TF} → Schedules to follow the run.`);
