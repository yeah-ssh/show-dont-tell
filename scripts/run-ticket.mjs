#!/usr/bin/env node
// Drive the ticket-resolver agent from the terminal and watch its tool calls.
// Usage: node scripts/run-ticket.mjs TRU-5 [--approve=create_pull_request,send_customer_reply] [--deny=...]
// Unlisted approvals stop the run; finish them in the TrueForge UI (the session link is printed).

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const issue = process.argv[2];
if (!issue) {
  console.error('usage: node scripts/run-ticket.mjs <ISSUE-ID> [--approve=tool,...] [--deny=tool,...]');
  process.exit(1);
}
const flag = name => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? '').split('=')[1]?.split(',').filter(Boolean) ?? [];
const approve = new Set(flag('approve'));
const deny = new Set(flag('deny'));
const TF = process.env.TRUEFORGE_URL || 'http://localhost:8790';
const client = new TrueForge({ baseUrl: TF, timeoutInSeconds: 1800 });

const t0 = Date.now();
const stamp = () => `[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`;
const short = (s, n = 160) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

// --session=<id> resumes an existing session (e.g. after a tool timeout) instead of starting fresh.
const resumeId = flag('session')[0];
const session = resumeId
  ? { id: resumeId }
  : (await client.sessions.create({ agent: { name: 'ticket-resolver' }, metadata: { linear_issue: issue } })).data;
if (!resumeId) await client.sessions.update(session.id, { title: `${issue} (cli)` });
console.log(`session ${session.id}\n${TF}/sessions/${session.id}\n`);

const toolNames = new Map();
let input = [{
  type: 'user.message',
  content: resumeId
    ? 'The previous turn was interrupted by a tool error. Check what already happened (e.g. whether the PR exists), redo only what is missing, and continue the procedure to the Verdict card.'
    : `Resolve Linear issue ${issue}.`,
}];

// Print full events from the REST API (the stream carries partial deltas).
const seen = new Set();
async function printNewEvents() {
  const res = await fetch(`${TF}/api/v1/sessions/${session.id}/events?limit=50`).then(r => r.json()).catch(() => ({ data: [] }));
  for (const { event: ev } of [...(res.data ?? [])].reverse()) {
    if (!ev?.id || seen.has(ev.id)) continue;
    seen.add(ev.id);
    if (ev.type === 'model.message') {
      const text = Array.isArray(ev.content) ? ev.content.map(c => c.text ?? '').join('') : ev.content;
      if (text?.trim()) console.log(`${stamp()} 💬 ${short(text, 500)}`);
      for (const call of ev.tool_calls ?? []) {
        let name = call.function?.name;
        // Deferred tools arrive as call_tool({mcp_server, tool_name, input}); show the real tool.
        if (name === 'call_tool') {
          try {
            const a = JSON.parse(call.function.arguments);
            name = `${a.mcp_server}.${a.tool_name}`;
          } catch {}
        }
        toolNames.set(call.id, name);
        console.log(`${stamp()} 🔧 ${name}(${short(call.function?.arguments, 220)})`);
      }
    } else if (ev.type === 'tool.response') {
      console.log(`${stamp()}    ↳ ${toolNames.get(ev.tool_call_id) ?? ''}: ${short(ev.content, 260)}`);
    } else if (ev.type === 'sandbox.created') {
      console.log(`${stamp()} 📦 sandbox created`);
    }
  }
}
const poller = setInterval(() => void printNewEvents(), 2500);

let nudges = 0;
for (let round = 0; round < 12; round++) {
  const pending = [];
  let done;
  const stream = await client.sessions.createTurnStream(session.id, { input });
  for await (const ev of stream) {
    if (ev.type === 'tool.approval_required') {
      for (const ref of ev.toolCalls ?? ev.tool_calls ?? []) pending.push({ id: ref.id, threadId: ev.threadId ?? ev.thread_id });
    } else if (ev.type === 'turn.done') {
      done = ev;
    }
  }
  await printNewEvents();
  const state = done?.state;
  if (state?.type === 'error' || state?.status === 'error') {
    console.log(`${stamp()} ✗ turn error: ${JSON.stringify(state).slice(0, 800)}`);
    break;
  }
  if (!pending.length) {
    // Models occasionally end a turn early. If there's no Verdict yet, nudge once or twice.
    const finalText = JSON.stringify(state?.output ?? '');
    if (!/verdict/i.test(finalText) && nudges < 2) {
      nudges++;
      console.log(`${stamp()} ↻ turn ended without a Verdict; nudging to continue (${nudges}/2)`);
      input = [{ type: 'user.message', content: 'Continue the ui-bug-repro procedure from where you stopped, through to the Verdict card.' }];
      continue;
    }
    const m = state?.metrics;
    console.log(`\n${stamp()} ✓ turn finished${m ? ` · cost $${m.totalCostInUsd ?? m.total_cost_in_usd ?? '?'}` : ''}`);
    break;
  }
  input = [];
  for (const p of pending) {
    const name = (toolNames.get(p.id) ?? '?').split('.').pop();
    if (approve.has(name)) {
      console.log(`${stamp()} ⏸  approval: ${name} → ALLOW (cli flag)`);
      input.push({ type: 'user.tool_approval', threadId: p.threadId, toolCallId: p.id, approval: { status: 'allow' } });
    } else if (deny.has(name)) {
      console.log(`${stamp()} ⏸  approval: ${name} → DENY (cli flag)`);
      input.push({ type: 'user.tool_approval', threadId: p.threadId, toolCallId: p.id, approval: { status: 'deny', reason: 'Denied by operator' } });
    } else {
      console.log(`${stamp()} ⏸  approval needed: ${name}. Approve it in the UI: ${TF}/sessions/${session.id}`);
    }
  }
  if (input.length < pending.length) break;
}
clearInterval(poller);
