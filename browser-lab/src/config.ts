import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const envFile = resolve(import.meta.dirname, '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function ghToken(): string {
  const fromEnv = env('GITHUB_TOKEN');
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const labRoot = resolve(import.meta.dirname, '..');

export const config = {
  port: Number(env('LAB_PORT', '8900')),
  host: env('LAB_HOST', '127.0.0.1'),
  labRoot,
  dataDir: resolve(env('LAB_DATA_DIR', join(labRoot, '.lab'))),

  // The app the agent is fixing. Cloned once, then copied per run.
  targetRepo: env('TARGET_REPO', 'https://github.com/yeah-ssh/demo-shop'),
  targetRef: env('TARGET_REF', 'main'),
  appStartCommand: env('APP_START_COMMAND', 'python3 server.py --port {port}'),
  appHealthPath: env('APP_HEALTH_PATH', '/healthz'),

  // host: Playwright runs in a locked-down child process on this machine.
  // docker: every run is a throwaway container with no network (see Dockerfile).
  runner: env('LAB_RUNNER', 'host') as 'host' | 'docker',
  dockerImage: env('LAB_DOCKER_IMAGE', 'browser-lab:latest'),
  runTimeoutMs: Number(env('LAB_RUN_TIMEOUT_MS', '90000')),
  browsersPath: env('PLAYWRIGHT_BROWSERS_PATH', join(homedir(), 'Library', 'Caches', 'ms-playwright')),

  // Where evidence (videos, GIFs, screenshots) is published so humans can open it.
  // github: committed to a public repo, served from raw.githubusercontent.com.
  // local: served by this server at /evidence (only reachable from this machine).
  evidenceStore: env('EVIDENCE_STORE', 'github') as 'github' | 'local',
  evidenceRepo: env('EVIDENCE_REPO', 'yeah-ssh/show-dont-tell-evidence'),
  evidenceBranch: env('EVIDENCE_BRANCH', 'main'),
  githubToken: ghToken(),

  // Vision double-check. Point OPENAI_BASE_URL at the TrueFoundry AI Gateway to route through it.
  ...(env('TFY_GATEWAY_BASE_URL') && env('TFY_API_KEY')
    ? {
        openaiApiKey: env('TFY_API_KEY'),
        openaiBaseUrl: env('TFY_GATEWAY_BASE_URL'),
        visionModel: env('TFY_VISION_MODEL', 'openai-main/gpt-5.4-mini'),
      }
    : {
        openaiApiKey: env('OPENAI_API_KEY'),
        openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        visionModel: env('VISION_MODEL', 'gpt-5.4-mini'),
      }),

  // Customer replies (the irreversible action).
  resendApiKey: env('RESEND_API_KEY'),
  replyFrom: env('REPLY_FROM', 'Demo Shop Support <onboarding@resend.dev>'),
  replyOverrideTo: env('REPLY_OVERRIDE_TO'),
  linearApiKey: env('LINEAR_API_KEY'),
};

export type Viewport = { width: number; height: number };
