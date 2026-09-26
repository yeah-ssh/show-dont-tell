#!/usr/bin/env node
// Configures a running TrueForge server for Show-Don't-Tell, idempotently:
// model provider → MCP connectors → skill → agent. Safe to re-run after changing .env.
//
// Usage: node scripts/bootstrap.mjs

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const env = (k, d = '') => process.env[k]?.trim() || d;
const TF = env('TRUEFORGE_URL', 'http://localhost:8790');
const AGENT_NAME = 'ticket-resolver';
const LAB_URL = env('LAB_MCP_URL', 'http://127.0.0.1:8900/mcp');
const TARGET_REPO = env('TARGET_REPO', 'https://github.com/yeah-ssh/demo-shop');
const SKILL_REPO = env('SKILL_REPO', 'https://github.com/yeah-ssh/show-dont-tell');
const SKILL_REF = env('SKILL_REF', 'main');

const LINEAR_TOOLS = ['get_issue', 'list_comments', 'save_comment', 'save_issue', 'list_issue_statuses', 'list_issues', 'list_issue_labels'];
const TRIAGE_LABEL = 'agent-handled';
const SCHEDULE_NAME = 'bug-triage-sweep';
const GITHUB_TOOLS = ['create_branch', 'push_files', 'create_pull_request', 'get_file_contents'];
const LAB_TOOLS = ['run_repro', 'compose_evidence', 'verify_screens', 'send_customer_reply'];

const ok = msg => console.log(`  ✓ ${msg}`);
const warn = msg => console.log(`  ! ${msg}`);
const die = msg => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

async function api(method, path, body) {
  const res = await fetch(`${TF}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return json;
}

function githubToken() {
  if (env('GITHUB_TOKEN')) return env('GITHUB_TOKEN');
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function waitForTrueForge() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${TF}/healthz`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  die(`TrueForge is not reachable at ${TF}. Start it first (see README).`);
}

async function configureModel() {
  console.log('\n1. Model provider');
  const catalog = await api('GET', '/api/v1/catalogs/model-providers');
  const openaiCatalog = catalog.data.find(p => p.type === 'openai')?.models ?? [];
  const props = modelId =>
    openaiCatalog.find(m => m.model_id === modelId || modelId.endsWith(`/${m.model_id}`))?.properties ?? {
      context_length: 400000,
      max_output_tokens: 128000,
    };
  const hyphen = s => s.split('/').pop().replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  if (env('TFY_GATEWAY_BASE_URL') && env('TFY_API_KEY')) {
    const modelId = env('TFY_AGENT_MODEL') || die('TFY_AGENT_MODEL is required with the TrueFoundry gateway (e.g. openai-main/gpt-5.6-sol)');
    const name = hyphen(modelId);
    await api('PUT', '/api/v1/settings/model-providers', {
      manifest: {
        type: 'custom',
        name: 'tfy-gateway',
        base_url: env('TFY_GATEWAY_BASE_URL'),
        auth: { api_key: env('TFY_API_KEY') },
        models: [{ model_id: modelId, name, properties: props(modelId) }],
      },
    });
    ok(`TrueFoundry AI Gateway → ${modelId}`);
    return `tfy-gateway/${name}`;
  }

  const key = env('OPENAI_API_KEY') || die('Set OPENAI_API_KEY (or the TFY_* gateway variables) in .env');
  const modelId = env('AGENT_MODEL', 'gpt-5.6-sol');
  const name = hyphen(modelId);
  await api('PUT', '/api/v1/settings/model-providers', {
    manifest: { type: 'openai', auth: { api_key: key }, models: [{ model_id: modelId, name, properties: props(modelId) }] },
  });
  ok(`OpenAI → ${modelId}`);
  return `openai/${name}`;
}

async function putMcp(manifest) {
  await api('PUT', '/api/v1/settings/mcp-servers', { manifest });
  try {
    const tools = await api('GET', `/api/v1/mcp-servers/${manifest.name}/tools`);
    const names = (tools.data ?? tools.tools ?? []).map(t => t.name);
    ok(`${manifest.name}: ${names.length} tools available`);
    return names;
  } catch (err) {
    warn(`${manifest.name}: registered, but listing tools failed (${err.message.slice(0, 160)})`);
    return null;
  }
}

function pick(wanted, available, server) {
  if (!available) return wanted;
  const missing = wanted.filter(t => !available.includes(t));
  if (missing.length) warn(`${server}: not found, skipped: ${missing.join(', ')}`);
  return wanted.filter(t => available.includes(t));
}

async function configureMcp() {
  console.log('\n2. MCP connectors');
  const servers = [];

  if (env('TFY_MCP_URL')) {
    const available = await putMcp({
      type: 'remote',
      name: 'ticket-tools',
      url: env('TFY_MCP_URL'),
      description: 'TrueFoundry MCP Gateway (Virtual MCP): curated Linear + GitHub tools for resolving bug tickets.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${env('TFY_API_KEY')}` } },
    });
    servers.push({
      name: 'ticket-tools',
      enable_tools: pick([...LINEAR_TOOLS, ...GITHUB_TOOLS], available, 'ticket-tools'),
      preload: true,
      require_approval_for_tools: ['create_pull_request'],
    });
  } else {
    const linearKey = env('LINEAR_API_KEY') || die('Set LINEAR_API_KEY in .env (or TFY_MCP_URL)');
    const linear = await putMcp({
      type: 'remote',
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      description: 'Linear: read bug tickets, comment, update status.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${linearKey}` } },
    });
    servers.push({ name: 'linear', enable_tools: pick(LINEAR_TOOLS, linear, 'linear'), preload: true, require_approval_for_tools: [] });

    const gh = githubToken() || die('Set GITHUB_TOKEN in .env or run `gh auth login`');
    const github = await putMcp({
      type: 'remote',
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      description: 'GitHub: branches, files and pull requests for the target repo.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${gh}`, 'X-MCP-Toolsets': 'repos,pull_requests' } },
    });
    servers.push({
      name: 'github',
      enable_tools: pick(GITHUB_TOOLS, github, 'github'),
      preload: true,
      require_approval_for_tools: ['create_pull_request'],
    });
  }

  const lab = await putMcp({
    type: 'remote',
    name: 'browser-lab',
    url: LAB_URL,
    description: 'Isolated browser lab: reproduce UI bugs with Playwright, record video evidence, send the approved customer reply.',
  });
  if (!lab) warn('Is the lab running (npm run lab), and was TrueForge started with OUTBOUND_URL_ALLOWED_HOSTS?');
  servers.push({
    name: 'browser-lab',
    enable_tools: pick(LAB_TOOLS, lab, 'browser-lab'),
    preload: true,
    require_approval_for_tools: ['send_customer_reply'],
  });
  return servers;
}

async function configureSkill() {
  console.log('\n3. Skill');
  await api('PUT', '/api/v1/settings/skills', {
    manifest: {
      type: 'git',
      name: 'ui-bug-repro',
      url: SKILL_REPO,
      path: 'skills/ui-bug-repro',
      ref: SKILL_REF,
      description:
        'Resolve a UI bug ticket with video proof: reproduce in the browser lab, fix in the sandbox, before/after evidence, PR, approved customer reply; honest could-not-reproduce path.',
    },
  });
  ok(`ui-bug-repro from ${SKILL_REPO}@${SKILL_REF}`);
}

async function configureAgent(model, mcpServers) {
  console.log('\n4. Agent');
  const repoPath = TARGET_REPO.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const instructions = readFileSync(join(root, 'agent', 'instructions.md'), 'utf8').replaceAll('{{TARGET_REPO}}', repoPath);
  const manifest = {
    model: { name: model, params: { reasoning_effort: 'medium' } },
    instructions,
    mcp_servers: mcpServers,
    skills: [{ name: 'ui-bug-repro' }],
    config: {
      sandbox: { enabled: true, file_downloads: true },
      generative_ui: { enabled: true },
      ask_user_questions: { enabled: true },
      dynamic_sub_agents: { enabled: false },
      iteration_limit: 150,
      context_management: { compaction: { enabled: true }, large_tool_response: { enabled: true } },
    },
  };
  const description = 'Reproduces UI bugs from Linear tickets in an isolated browser, fixes them, and answers with before/after video proof.';
  const existing = (await api('GET', '/api/v1/agents')).data?.find(a => a.name === AGENT_NAME);
  if (existing) {
    await api('PUT', `/api/v1/agents/${existing.id}`, { description, manifest });
    ok(`updated agent "${AGENT_NAME}" (${existing.id})`);
  } else {
    const created = await api('POST', '/api/v1/agents', { name: AGENT_NAME, description, manifest });
    ok(`created agent "${AGENT_NAME}" (${created.data?.id})`);
  }
}

async function linear(query, variables) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: env('LINEAR_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

async function configureSchedule() {
  console.log('\n5. Auto-triage schedule');
  const teamKey = env('LINEAR_TEAM_KEY');
  if (!teamKey || !env('LINEAR_API_KEY')) {
    warn('skipped: set LINEAR_API_KEY and LINEAR_TEAM_KEY to enable the triage sweep');
    return;
  }
  // The sweep claims tickets with this label so later runs skip them.
  const { teams } = await linear(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id labels(filter: { name: { eq: "${TRIAGE_LABEL}" } }) { nodes { id } } } } }`, { key: teamKey });
  const team = teams.nodes[0];
  if (!team) die(`No Linear team with key ${teamKey}`);
  if (!team.labels.nodes.length) {
    await linear(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`, {
      input: { teamId: team.id, name: TRIAGE_LABEL, color: '#1b998b', description: 'Picked up by the Show-Don\'t-Tell agent' },
    });
    ok(`created Linear label "${TRIAGE_LABEL}"`);
  } else {
    ok(`Linear label "${TRIAGE_LABEL}" exists`);
  }

  const manifest = {
    task: `Run a triage sweep of Linear team ${teamKey}: pick the oldest unhandled UI bug ticket and resolve it, following "Triage sweep mode" in the ui-bug-repro skill.`,
    cron: env('TRIAGE_CRON', '0 * * * *'),
    timezone: env('TRIAGE_TIMEZONE', 'Asia/Kolkata'),
    status: env('TRIAGE_SCHEDULE', 'active') === 'paused' ? 'paused' : 'active',
  };
  const existing = (await api('GET', '/api/v1/schedules')).data?.find(s => s.name === SCHEDULE_NAME);
  if (existing) {
    await api('PUT', `/api/v1/schedules/${existing.id}`, { name: SCHEDULE_NAME, manifest });
    ok(`updated schedule "${SCHEDULE_NAME}" (${manifest.cron}, ${manifest.timezone}, ${manifest.status})`);
  } else {
    await api('POST', '/api/v1/schedules', { agent_name: AGENT_NAME, name: SCHEDULE_NAME, manifest });
    ok(`created schedule "${SCHEDULE_NAME}" (${manifest.cron}, ${manifest.timezone}, ${manifest.status})`);
  }
}

console.log(`Configuring TrueForge at ${TF}`);
await waitForTrueForge();
const caps = await api('GET', '/api/v1/capabilities');
caps.data?.sandbox?.enabled ? ok('sandbox available') : warn('sandbox is NOT enabled; skills and exec will not work');
const model = await configureModel();
const servers = await configureMcp();
await configureSkill();
await configureAgent(model, servers);
await configureSchedule();
console.log(`\nDone. Open ${TF} and pick the "${AGENT_NAME}" agent.`);
