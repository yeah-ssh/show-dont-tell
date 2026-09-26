import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { config } from './config.js';
import { mustRun } from './proc.js';
import type { RunMeta } from './runs.js';
import { publish, viewerUrl } from './storage.js';

export type Panel = { run: RunMeta; label: string; tone: 'bad' | 'good' | 'neutral' };

const TONES = { bad: '#d7263d', good: '#1b998b', neutral: '#44475a' } as const;
const PANEL_HEIGHT = 540;

/** Renders each caption to a transparent PNG (Homebrew ffmpeg ships without drawtext). */
async function renderLabels(panels: Panel[], dir: string): Promise<string[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 80 } });
    const paths: string[] = [];
    for (const [i, p] of panels.entries()) {
      const sub = `${p.run.browser} · ${p.run.viewport.width}×${p.run.viewport.height}`;
      await page.setContent(`
        <div id="l" style="display:inline-block;font:700 26px -apple-system,Helvetica,Arial,sans-serif;
          color:#fff;background:${TONES[p.tone]};padding:10px 16px;border-radius:10px;opacity:.93">
          ${p.label}<div style="font:500 15px -apple-system,Helvetica,Arial,sans-serif;opacity:.9">${sub}</div>
        </div>`);
      const path = join(dir, `label-${i}.png`);
      await page.locator('#l').screenshot({ path, omitBackground: true });
      paths.push(path);
    }
    return paths;
  } finally {
    await browser.close();
  }
}

/**
 * Side-by-side video of 1–3 runs with captions, plus a GIF preview.
 * Clips are scaled to the same height, and the shorter clip holds its last frame.
 */
export async function composePanels(panels: Panel[], title: string) {
  if (panels.length < 1 || panels.length > 3) throw new Error('compose 1 to 3 runs');
  for (const p of panels) if (!p.run.video_path) throw new Error(`run ${p.run.run_id} has no video`);

  const id = `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
  const dir = join(config.dataDir, 'evidence', id);
  await mkdir(dir, { recursive: true });
  const labels = await renderLabels(panels, dir);

  const inputs = [...panels.flatMap(p => ['-i', p.run.video_path!]), ...labels.flatMap(l => ['-i', l])];
  const n = panels.length;
  const chains = panels.map(
    (_, i) =>
      `[${i}:v]fps=25,scale=-2:${PANEL_HEIGHT},setsar=1,tpad=stop_mode=clone:stop_duration=4[v${i}];` +
      `[v${i}][${n + i}:v]overlay=16:16[p${i}]`,
  );
  const stack = n === 1 ? `[p0]null[out]` : `${panels.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${n}:shortest=0[out]`;
  const mp4 = join(dir, 'evidence.mp4');
  await mustRun('ffmpeg', [
    '-y', '-loglevel', 'error', ...inputs,
    '-filter_complex', `${chains.join(';')};${stack}`,
    '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '30', '-preset', 'veryfast',
    '-movflags', '+faststart', '-an', mp4,
  ], { timeoutMs: 180_000 });

  const gif = join(dir, 'evidence.gif');
  await mustRun('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', mp4,
    '-vf', 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
    '-loop', '0', gif,
  ], { timeoutMs: 180_000 });

  const mp4Url = await publish(mp4, `evidence/${id}/evidence.mp4`);
  const gifUrl = await publish(gif, `evidence/${id}/evidence.gif`);
  const sizeMb = (await stat(mp4)).size / 1e6;
  return {
    evidence_id: id,
    title,
    mp4_url: mp4Url,
    mp4_viewer_url: viewerUrl(mp4Url),
    gif_url: gifUrl,
    mp4_size_mb: Math.round(sizeMb * 100) / 100,
    markdown: `![${title}](${gifUrl})\n\n▶️ [Watch the full video](${viewerUrl(mp4Url)})`,
  };
}
