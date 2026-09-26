import { spawn, type SpawnOptions } from 'node:child_process';

export type ProcResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Run a command to completion, capturing output, with a hard timeout. */
export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { timeoutMs?: number; input?: string } = {},
): Promise<ProcResult> {
  const { timeoutMs = 60_000, input, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOpts, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', d => (stdout += d));
    child.stderr?.on('data', d => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin?.end(input ?? '');
  });
}

/** Run and throw with stderr on non-zero exit. */
export async function mustRun(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<string> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.code}${res.timedOut ? ', timed out' : ''}): ${res.stderr.slice(-1500)}`);
  }
  return res.stdout;
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
