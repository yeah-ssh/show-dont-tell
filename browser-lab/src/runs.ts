import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { config, type Viewport } from './config.js';
import { killTree, mustRun, run } from './proc.js';
import { publish } from './storage.js';

export type RunMeta = {
  run_id: string;
  label: string;
  browser: 'chromium' | 'firefox';
  viewport: Viewport;
  mobile: boolean;
  patched: boolean;
  outcome: 'passed' | 'failed' | 'script_error' | 'infra_error';
  reproduced: boolean;
  error: { name: string; message: string; is_assertion?: boolean } | null;
  console_errors: string[];
  page_errors: string[];
  blocked_requests: string[];
  runner: string;
  duration_ms: number;
  video_path?: string;
  screenshot_path?: string;
  video_url?: string;
  screenshot_url?: string;
};

const repoRoot = resolve(config.labRoot, '..');
const mirrorDir = () => join(config.dataDir, 'target.git');
export const runDir = (runId: string) => join(config.dataDir, 'runs', runId);

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? res(addr.port) : rej(new Error('no port'))));
    });
  });
}

/** Clean checkout of the target app at the base ref, with an optional unified diff applied. */
async function prepareCheckout(dir: string, patch?: string): Promise<void> {
  const mirror = mirrorDir();
  if (!existsSync(mirror)) {
    await mkdir(dirname(mirror), { recursive: true });
    await mustRun('git', ['clone', '--quiet', '--mirror', config.targetRepo, mirror], { timeoutMs: 120_000 });
  } else {
    // Refresh the cached mirror, but don't fail the run on a flaky network: the cached copy is
    // almost always current, and a stale base is better than no reproduction at all.
    const res = await run('git', ['-C', mirror, 'remote', 'update', '--prune'], { timeoutMs: 20_000 });
    if (res.code !== 0) console.warn(`mirror refresh failed (${res.timedOut ? 'timed out' : res.code}); using cached copy`);
  }
  await mustRun('git', ['clone', '--quiet', mirror, dir], { timeoutMs: 60_000 });
  await mustRun('git', ['-C', dir, 'checkout', '--quiet', config.targetRef]);
  if (patch?.trim()) {
    const patchFile = join(dir, '..', 'fix.patch');
    await writeFile(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);
    const res = await run('git', ['-C', dir, 'apply', '--whitespace=nowarn', '--recount', patchFile]);
    if (res.code !== 0) throw new PatchError(res.stderr.trim() || 'git apply failed');
  }
}

export class PatchError extends Error {}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`app did not become healthy at ${url}`);
}

async function runOnHost(dir: string, appDir: string, input: object): Promise<void> {
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const [cmd, ...args] = config.appStartCommand.replace('{port}', String(port)).split(/\s+/);
  const app = spawn(cmd, args, {
    cwd: appDir,
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  });
  try {
    await waitForHealth(`${baseURL}${config.appHealthPath}`, 15_000);
    const home = join(dir, 'home');
    await mkdir(join(home, 'tmp'), { recursive: true });
    // Node permission model: the agent's script may only write inside its run directory
    // and cannot load native addons or open worker threads. Network is limited by request routing.
    const nodeArgs =
      process.env.LAB_NODE_PERMISSION === '0'
        ? []
        : [
            '--permission',
            `--allow-fs-read=${repoRoot}`,
            `--allow-fs-read=${config.browsersPath}`,
            `--allow-fs-read=${dir}`,
            `--allow-fs-write=${dir}`,
            '--allow-child-process',
          ];
    const res = await run(process.execPath, [...nodeArgs, join(config.labRoot, 'runner', 'run.mjs')], {
      cwd: dir,
      timeoutMs: config.runTimeoutMs,
      input: JSON.stringify({ ...input, baseURL, outDir: dir }),
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: join(home, 'tmp'),
        PLAYWRIGHT_BROWSERS_PATH: config.browsersPath,
      },
    });
    if (res.timedOut) throw new Error(`run timed out after ${config.runTimeoutMs}ms`);
    if (res.code !== 0) throw new Error(`runner crashed: ${res.stderr.slice(-1500)}`);
  } finally {
    killTree(app.pid);
  }
}

async function runInDocker(dir: string, appDir: string, input: object): Promise<void> {
  const port = 5000;
  const start = config.appStartCommand.replace('{port}', String(port));
  const script = [
    `cd /app && (${start} >/dev/null 2>&1 &)`,
    `for i in $(seq 1 75); do curl -fs http://127.0.0.1:${port}${config.appHealthPath} >/dev/null && break; sleep 0.2; done`,
    'node /lab/runner/run.mjs < /out/input.json',
  ].join(' && ');
  await writeFile(join(dir, 'input.json'), JSON.stringify({ ...input, baseURL: `http://127.0.0.1:${port}`, outDir: '/out' }));
  // Throwaway container: no network, read-only root, no capabilities, resource caps.
  const res = await run(
    'docker',
    [
      'run', '--rm', '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,size=512m', '--shm-size', '1g',
      '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'HOME=/tmp',
      '-v', `${appDir}:/app:ro`, '-v', `${dir}:/out`,
      config.dockerImage, 'bash', '-c', script,
    ],
    { timeoutMs: config.runTimeoutMs },
  );
  if (res.timedOut) throw new Error(`run timed out after ${config.runTimeoutMs}ms`);
  if (res.code !== 0) throw new Error(`container failed (${res.code}): ${res.stderr.slice(-1500)}`);
}

export async function toMp4(src: string, dest: string): Promise<void> {
  await mustRun('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', src,
    '-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-preset', 'veryfast',
    '-movflags', '+faststart', '-an', dest,
  ], { timeoutMs: 120_000 });
}

export async function executeRun(params: {
  script: string;
  patch?: string;
  browser: 'chromium' | 'firefox';
  viewport: Viewport;
  mobile: boolean;
  label: string;
}): Promise<RunMeta> {
  const runId = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomBytes(3).toString('hex')}`;
  const dir = runDir(runId);
  const appDir = join(dir, 'app');
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  const base: RunMeta = {
    run_id: runId,
    label: params.label,
    browser: params.browser,
    viewport: params.viewport,
    mobile: params.mobile,
    patched: Boolean(params.patch?.trim()),
    outcome: 'infra_error',
    reproduced: false,
    error: null,
    console_errors: [],
    page_errors: [],
    blocked_requests: [],
    runner: config.runner,
    duration_ms: 0,
  };

  try {
    await prepareCheckout(appDir, params.patch);
    const input = { script: params.script, browser: params.browser, viewport: params.viewport, mobile: params.mobile };
    await (config.runner === 'docker' ? runInDocker : runOnHost)(dir, appDir, input);
    const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    Object.assign(base, {
      outcome: result.outcome,
      reproduced: result.outcome === 'failed',
      error: result.error,
      console_errors: result.console_errors,
      page_errors: result.page_errors,
      blocked_requests: result.blocked_requests,
    });
    if (existsSync(join(dir, 'video.webm'))) {
      await toMp4(join(dir, 'video.webm'), join(dir, 'video.mp4'));
      base.video_path = join(dir, 'video.mp4');
      base.video_url = await publish(base.video_path, `runs/${runId}/video.mp4`);
    }
    if (existsSync(join(dir, 'final.png'))) {
      base.screenshot_path = join(dir, 'final.png');
      base.screenshot_url = await publish(base.screenshot_path, `runs/${runId}/final.png`);
    }
  } catch (err) {
    base.outcome = 'infra_error';
    base.error = {
      name: err instanceof PatchError ? 'PatchError' : 'LabError',
      message: (err as Error).message.slice(0, 2000),
    };
  }
  base.duration_ms = Date.now() - started;
  await writeFile(join(dir, 'meta.json'), JSON.stringify(base, null, 2));
  return base;
}

export async function loadRun(runId: string): Promise<RunMeta> {
  if (!/^[0-9a-f-]+$/i.test(runId)) throw new Error(`invalid run_id: ${runId}`);
  const path = join(runDir(runId), 'meta.json');
  if (!existsSync(path)) throw new Error(`unknown run_id: ${runId}`);
  return JSON.parse(await readFile(path, 'utf8'));
}
