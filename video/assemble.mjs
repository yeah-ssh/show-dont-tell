#!/usr/bin/env node
// Edits the launch video: scene clips sized to the narration → crossfades → burned-in captions
// → voiceover + ducked music bed → video/out/show-dont-tell-launch.mp4 (+ .srt).
// Needs: raw/vo/* (tts.mjs), raw/footage/* (capture.mjs), edit.json (footage windows).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStills } from './render-still.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, 'raw');
const WORK = join(RAW, 'work');
const OUT = join(here, 'out');
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

const FPS = 30;
const XF = 0.6; // crossfade length between scenes
const LEAD = 0.35; // silence before each scene's narration
const script = JSON.parse(readFileSync(join(here, 'script.json'), 'utf8'));
const edit = JSON.parse(readFileSync(join(here, 'edit.json'), 'utf8'));
const vo = id => JSON.parse(readFileSync(join(RAW, 'vo', `${id}.json`), 'utf8'));
const ff = (args, label) => {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    throw new Error(`ffmpeg failed: ${label}`);
  }
};
const probe = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

// ---- 1. Scene durations and timeline positions -------------------------------------------
const scenes = script.scenes.map(s => {
  const v = vo(s.id);
  return { ...s, vo: v, duration: +(LEAD + v.duration + (s.pad_after ?? 0.5)).toFixed(3) };
});
let t = 0;
for (const s of scenes) {
  s.start = t;
  t += s.duration - XF;
}
const total = t + XF;
console.log(`timeline ${total.toFixed(1)}s across ${scenes.length} scenes`);

// ---- 2. Stills: framed backdrops, window mask, captions ---------------------------------
const chips = [...new Set(scenes.map(s => s.chip).filter(Boolean))];
const stillJobs = [{ scene: 'frame', out: join(WORK, 'mask.png'), params: { mode: 'mask' } }];
chips.forEach((c, i) => stillJobs.push({ scene: 'frame', out: join(WORK, `frame-${i}.png`), params: { chip: c } }));
const captions = [];
for (const s of scenes) {
  for (const c of s.vo.captions) {
    captions.push({ text: c.text, start: s.start + LEAD + c.start, end: s.start + LEAD + c.end });
  }
}
// Keep each caption up until the next one starts (max 0.6 s gap), so text doesn't flicker.
captions.forEach((c, i) => {
  const next = captions[i + 1];
  c.end = next ? Math.min(next.start - 0.05, c.end + 0.6) : c.end + 0.8;
  c.png = join(WORK, `cap-${String(i).padStart(3, '0')}.png`);
  stillJobs.push({ scene: 'caption', out: c.png, params: { text: c.text }, transparent: true });
});
// On-screen labels for footage scenes (what the viewer is looking at).
const notes = edit.notes ?? {};
Object.entries(notes).forEach(([visual, list]) =>
  list.forEach((n, i) => {
    n.png = join(WORK, `note-${visual}-${i}.png`);
    stillJobs.push({ scene: 'note', out: n.png, params: { text: n.text, tone: n.tone }, transparent: true });
  }),
);
await renderStills(stillJobs);
console.log(`✓ ${stillJobs.length} stills (frames, mask, ${captions.length} captions)`);

// ---- 3. Scene clips ---------------------------------------------------------------------
// A footage segment: [from,to] of a source, optionally cropped (zoom into the region that matters),
// fitted to `dur` by speeding up (or holding the last frame).
function segment(seg, dur, out) {
  const src = join(RAW, 'footage', seg.src);
  const len = (seg.to ?? probe(src)) - (seg.from ?? 0);
  const speed = seg.speed ?? Math.max(1, len / dur);
  const played = len / speed;
  const hold = Math.max(0, dur - played);
  ff([
    '-ss', String(seg.from ?? 0), '-t', String(len), '-i', src,
    '-vf', `${seg.crop ? `crop=${seg.crop.w}:${seg.crop.h}:${seg.crop.x}:${seg.crop.y},` : ''}setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=${FPS},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},trim=duration=${dur.toFixed(3)}`,
    '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p', out,
  ], `segment ${seg.src}`);
}

function footageClip(s, out) {
  const segs = edit[s.visual.slice('footage:'.length)];
  if (!Array.isArray(segs)) throw new Error(`edit.json: ${s.visual} must be a list of segments`);
  if (!segs) throw new Error(`edit.json has no entry for ${s.visual}`);
  const weights = segs.reduce((a, g) => a + (g.weight ?? 1), 0);
  const parts = segs.map((g, i) => {
    const d = (s.duration * (g.weight ?? 1)) / weights + (i < segs.length - 1 ? 0.4 : 0);
    const p = join(WORK, `${s.id}-seg${i}.mp4`);
    segment(g, d, p);
    return { p, d };
  });
  // Join sub-segments with short crossfades.
  let raw = parts[0].p;
  if (parts.length > 1) {
    raw = join(WORK, `${s.id}-joined.mp4`);
    const inputs = parts.flatMap(x => ['-i', x.p]);
    let chain = '';
    let acc = parts[0].d;
    let last = '[0:v]';
    for (let i = 1; i < parts.length; i++) {
      const lbl = i === parts.length - 1 ? '[v]' : `[j${i}]`;
      chain += `${last}[${i}:v]xfade=transition=fade:duration=0.4:offset=${(acc - 0.4).toFixed(3)}${lbl};`;
      acc += parts[i].d - 0.4;
      last = lbl;
    }
    ff([...inputs, '-filter_complex', chain.slice(0, -1), '-map', '[v]', '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p', raw], `join ${s.id}`);
  }
  // Frame it: backdrop + footage in a rounded window. (A per-frame push-in resized the stream mid-graph,
  // which alphamerge can't handle; the footage itself carries the motion.)
  const frame = join(WORK, `frame-${chips.indexOf(s.chip)}.png`);
  const D = s.duration.toFixed(3);
  ff([
    '-loop', '1', '-t', D, '-i', frame,
    '-i', raw,
    '-loop', '1', '-t', D, '-i', join(WORK, 'mask.png'),
    '-filter_complex',
    `[1:v]scale=1680:945,setsar=1,format=yuv420p[f];` +
      `[2:v]crop=1680:945:120:90,format=gray[m];` +
      `[f][m]alphamerge[fm];[0:v][fm]overlay=120:90:shortest=1,fps=${FPS},format=yuv420p[v]`,
    '-map', '[v]', '-t', D, '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', out,
  ], `frame ${s.id}`);
  const list = notes[s.visual.slice('footage:'.length)] ?? [];
  if (list.length) {
    const labelled = out.replace(/\.mp4$/, '-notes.mp4');
    let chain = '';
    let last = '[0:v]';
    list.forEach((n, i) => {
      const lbl = i === list.length - 1 ? '[v]' : `[n${i}]`;
      const a = n.at;
      const b = n.at + n.dur;
      // fade each label in and out over 0.25 s
      chain += `[${i + 1}:v]format=rgba,fade=t=in:st=${a}:d=0.25:alpha=1,fade=t=out:st=${(b - 0.25).toFixed(2)}:d=0.25:alpha=1[l${i}];`;
      chain += `${last}[l${i}]overlay=0:0:enable='between(t,${a},${b})'${lbl};`;
      last = lbl;
    });
    ff(['-i', out, ...list.flatMap(n => ['-loop', '1', '-t', D, '-i', n.png]), '-filter_complex', chain.slice(0, -1), '-map', '[v]', '-t', D, '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p', labelled], `notes ${s.id}`);
    execFileSync('mv', [labelled, out]);
  }
}

const clips = [];
for (const s of scenes) {
  const out = join(WORK, `${s.id}.mp4`);
  if (s.visual.startsWith('scene:')) {
    const words = s.vo.words.map(w => ({ w: w.w, start: +(w.start + LEAD).toFixed(3) }));
    execFileSync('node', [join(here, 'render-scene.mjs'), s.visual.slice(6), String(s.duration), out, JSON.stringify({ words })], { stdio: 'inherit' });
  } else {
    footageClip(s, out);
    console.log(`✓ ${s.id} (footage, ${s.duration}s)`);
  }
  clips.push(out);
}

// ---- 4. Crossfade all scenes ------------------------------------------------------------
const TRANSITIONS = { '03-title': 'fadeblack', '04-linear': 'smoothleft', '08-gates': 'fade', '13-architecture': 'fadeblack', '14-close': 'fade' };
const joined = join(WORK, 'joined.mp4');
{
  let chain = '';
  let last = '[0:v]';
  for (let i = 1; i < scenes.length; i++) {
    const tr = TRANSITIONS[scenes[i].id] ?? 'fade';
    const lbl = i === scenes.length - 1 ? '[v]' : `[x${i}]`;
    chain += `${last}[${i}:v]xfade=transition=${tr}:duration=${XF}:offset=${scenes[i].start.toFixed(3)}${lbl};`;
    last = lbl;
  }
  ff([...clips.flatMap(c => ['-i', c]), '-filter_complex', chain.slice(0, -1), '-map', '[v]', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', joined], 'crossfades');
}
console.log('✓ crossfaded');

// ---- 5. Captions (in batches, to keep filter graphs small) -----------------------------
let current = joined;
const BATCH = 20;
for (let b = 0; b < captions.length; b += BATCH) {
  const batch = captions.slice(b, b + BATCH);
  const out = join(WORK, `captioned-${b}.mp4`);
  let chain = '';
  let last = '[0:v]';
  batch.forEach((c, i) => {
    const lbl = i === batch.length - 1 ? '[v]' : `[c${i}]`;
    chain += `${last}[${i + 1}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'${lbl};`;
    last = lbl;
  });
  ff(['-i', current, ...batch.flatMap(c => ['-i', c.png]), '-filter_complex', chain.slice(0, -1), '-map', '[v]', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', out], `captions ${b}`);
  current = out;
}
console.log('✓ captions burned in');

// ---- 6. Audio: voiceover + generated ambient pad, ducked; loudness-normalised ------------
const voInputs = scenes.flatMap(s => ['-i', join(RAW, 'vo', `${s.id}.mp3`)]);
const delays = scenes.map((s, i) => `[${i}:a]adelay=${Math.round((s.start + LEAD) * 1000)}|${Math.round((s.start + LEAD) * 1000)},aformat=channel_layouts=stereo[a${i}]`).join(';');
const voMix = `${scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${scenes.length}:normalize=0,apad=whole_dur=${total.toFixed(2)}[vo]`;
// Pad: slow chord progression (Cmaj7 → Am7 → Fmaj7 → G6), soft sines with gentle tremolo.
const chords = [[261.63, 329.63, 392.0, 493.88], [220.0, 261.63, 329.63, 392.0], [174.61, 220.0, 261.63, 329.63], [196.0, 246.94, 293.66, 329.63]];
const CH = 8;
const expr = chords
  .map((c, i) => {
    const on = `between(mod(t,${CH * 4}),${i * CH},${(i + 1) * CH})`;
    const env = `min(1,(mod(t,${CH})/2))*min(1,((${CH}-mod(t,${CH}))/2))`;
    return `${on}*${env}*(${c.map(f => `sin(2*PI*${f / 2}*t)`).join('+')})`;
  })
  .join('+');
const music = join(WORK, 'music.wav');
ff(['-f', 'lavfi', '-i', `aevalsrc='0.05*(${expr})*(0.85+0.15*sin(2*PI*0.2*t))':s=44100:d=${total.toFixed(2)}`,
  '-af', `lowpass=f=1400,aecho=0.6:0.5:120|240:0.25|0.18,afade=t=in:d=3,afade=t=out:st=${(total - 4).toFixed(2)}:d=4,aformat=channel_layouts=stereo`, music], 'music');
const audio = join(WORK, 'audio.m4a');
ff([...voInputs, '-i', music, '-filter_complex',
  `${delays};${voMix};[vo]asplit[vo1][vo2];[${scenes.length}:a]volume=0.55[mu];[mu][vo2]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=500[duck];[vo1][duck]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
  '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(2), audio], 'audio mix');

// ---- 7. Mux + subtitles -------------------------------------------------------------------
const final = join(OUT, 'show-dont-tell-launch.mp4');
ff(['-i', current, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', final], 'mux');
const ts = x => {
  const ms = Math.round(x * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};
writeFileSync(join(OUT, 'show-dont-tell-launch.srt'), captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));
console.log(`\n✓ ${final}  (${probe(final).toFixed(1)}s)`);
