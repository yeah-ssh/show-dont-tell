#!/usr/bin/env node
// Voiceover per scene via ElevenLabs /with-timestamps → raw/vo/<id>.mp3 + <id>.json
// (duration, word timings, caption chunks). Skips scenes whose narration hasn't changed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const KEY = process.env.ELEVENLABS_API_KEY?.trim();
if (!KEY) throw new Error('ELEVENLABS_API_KEY missing in .env');

const script = JSON.parse(readFileSync(join(here, 'script.json'), 'utf8'));
const outDir = join(here, 'raw', 'vo');
mkdirSync(outDir, { recursive: true });

function wordsFromAlignment(a) {
  const words = [];
  let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur), (cur = null);
      return;
    }
    if (!cur) cur = { w: '', start: a.character_start_times_seconds[i], end: 0 };
    cur.w += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words;
}

// 3–8 words per caption; break early after sentence punctuation or at 8 words.
function captions(words) {
  const out = [];
  let chunk = [];
  const flush = () => {
    if (!chunk.length) return;
    out.push({ text: chunk.map(w => w.w).join(' '), start: chunk[0].start, end: chunk.at(-1).end });
    chunk = [];
  };
  for (const w of words) {
    chunk.push(w);
    const hardStop = /[.!?]$/.test(w.w);
    const softStop = /[,:;]$/.test(w.w) && chunk.length >= 4;
    if (hardStop || softStop || chunk.length >= 8) flush();
  }
  flush();
  return out;
}

for (const scene of script.scenes) {
  const meta = join(outDir, `${scene.id}.json`);
  if (existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).narration === scene.narration) {
    console.log(`= ${scene.id} (cached)`);
    continue;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${script.voice_id}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: scene.narration,
      model_id: script.model_id,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true, speed: 0.97 },
    }),
  });
  if (!res.ok) throw new Error(`${scene.id}: ElevenLabs ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const mp3 = join(outDir, `${scene.id}.mp3`);
  writeFileSync(mp3, Buffer.from(json.audio_base64, 'base64'));
  const duration = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3], { encoding: 'utf8' }).trim(),
  );
  const words = wordsFromAlignment(json.alignment);
  writeFileSync(meta, JSON.stringify({ narration: scene.narration, duration, words, captions: captions(words) }, null, 2));
  console.log(`✓ ${scene.id}  ${duration.toFixed(2)}s  ${words.length} words`);
}
