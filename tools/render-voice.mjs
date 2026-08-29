/**
 * Renders narration with ElevenLabs and measures what came back.
 *
 *   node tools/render-voice.mjs audition script/pilot.beats.json b1   # one beat, several voices
 *   node tools/render-voice.mjs render   script/pilot.beats.json      # all beats, the chosen voice
 *   node tools/render-voice.mjs render   script/pilot.beats.json --resume   # only what is missing
 *
 * The measured durations are the point. A beat's real length is what the timeline is built from —
 * the `plannedMs` in the beats file is only a hand estimate to get a first take shot. `render`
 * writes the measured value back, so regenerating the timeline is a mechanical step rather than a
 * guess.
 *
 * Uses the `with-timestamps` endpoint, which returns character-level alignment alongside the
 * audio. That alignment becomes the subtitle track, so subtitles are exact rather than
 * interpolated from a word count.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';

/** Voices worth hearing for an English build tutorial: clear educators plus one casual reader. */
export const AUDITION_VOICES = [
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', note: 'British, professional educator' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', note: 'American, upbeat educator' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', note: 'British, steady broadcaster' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', note: 'American, casual and down-to-earth' },
  // Public library rather than the account's own — the text-to-speech endpoint takes a shared
  // voice id directly, so there is nothing to add to the collection first.
  { id: 'Z2fsAwk7IblvPhYzfslC', name: 'Davis', note: 'American, casual and a shade deeper' },
];

async function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const file = join(homedir(), '.config', 'neodirect', 'elevenlabs.env');
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Error(`no ELEVENLABS_API_KEY and could not read ${file}`);
  });
  const match = /^\s*ELEVENLABS_API_KEY\s*=\s*(.+)$/m.exec(text);
  if (!match || !match[1].trim()) throw new Error(`${file} has no ELEVENLABS_API_KEY value`);
  return match[1].trim();
}

/** Returns { path, durationMs, alignment }. */
export async function speak({ text, voiceId, out, key }) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: MODEL }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${detail.slice(0, 300)}`);
  }
  const body = await response.json();

  await mkdir(join(out, '..'), { recursive: true }).catch(() => {});
  await writeFile(out, Buffer.from(body.audio_base64, 'base64'));

  return {
    path: out,
    durationMs: await durationMs(out),
    alignment: body.alignment ?? null,
  };
}

/** How long a rendered beat actually is. Asked of the file rather than of the API, which reports
 * characters and not seconds. */
async function durationMs(path) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ]);
  return Math.round(parseFloat(stdout.trim()) * 1000);
}

/**
 * Character-level alignment folded into readable lines, with the time each was spoken.
 *
 * <p>Pulled out of {@link toSrt} because a subtitle track is not the only thing that wants this:
 * the studio's timeline draws a lane of sentences under the cues, and it has to be the *same*
 * sentences at the *same* times as the ones the viewer will read. Two implementations of "where
 * does this sentence end" would drift, and the drift would only ever be visible in a finished
 * video.
 *
 * @param offsetSeconds where this beat starts in the finished episode — each beat's alignment is
 *                      relative to its own audio file, so without this every beat's lines would
 *                      start at zero and stack on top of one another
 * @returns `[{fromMs, toMs, text}]`, in order
 */
export function lines(alignment, { maxChars = 90, offsetSeconds = 0 } = {}) {
  if (!alignment) return [];
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;

  const cues = [];
  let text = '';
  let start = starts[0] ?? 0;

  const flush = (end) => {
    const trimmed = text.trim();
    if (trimmed) cues.push({ start, end, text: trimmed });
    text = '';
  };

  for (let i = 0; i < chars.length; i++) {
    text += chars[i];
    const atSentenceEnd = /[.!?]/.test(chars[i]) && !/\d/.test(chars[i + 1] ?? '');
    if (atSentenceEnd || text.length >= maxChars) {
      // Break on the sentence if we can; otherwise fall back to the last space so a word is
      // never split across two cues.
      if (!atSentenceEnd) {
        const lastSpace = text.lastIndexOf(' ');
        if (lastSpace > 20) {
          const carry = text.slice(lastSpace + 1);
          text = text.slice(0, lastSpace);
          flush(ends[i - carry.length] ?? ends[i]);
          start = starts[i - carry.length + 1] ?? ends[i];
          text = carry;
          continue;
        }
      }
      flush(ends[i]);
      start = starts[i + 1] ?? ends[i];
    }
  }
  flush(ends[ends.length - 1] ?? 0);

  return cues.map((cue) => ({
    fromMs: Math.max(0, Math.round((cue.start + offsetSeconds) * 1000)),
    toMs: Math.max(0, Math.round((cue.end + offsetSeconds) * 1000)),
    text: cue.text,
  }));
}

/**
 * The same lines, as an .srt file.
 *
 * @param firstIndex running cue number, since .srt numbering is continuous across the file
 */
export function toSrt(alignment, { maxChars = 90, offsetSeconds = 0, firstIndex = 1 } = {}) {
  const stamp = (ms) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
    const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
  };

  return lines(alignment, { maxChars, offsetSeconds })
    .map((line, i) => `${firstIndex + i}\n${stamp(line.fromMs)} --> ${stamp(line.toMs)}\n${line.text}\n`)
    .join('\n');
}

/**
 * The whole episode's subtitle track, and where each beat starts within it.
 *
 * Assembling it needs nothing but the alignments already on disk — no key, no network, no audio —
 * which is why it is a function rather than a step buried in the render: a subtitle file can be
 * rebuilt long after the voice was paid for.
 *
 * Mutates `beats` with the offsets it works out, because those are the same numbers the beats
 * document carries and computing them twice is how two clocks come apart.
 */
export async function subtitlesFor(beats, dir) {
  let srt = '';
  let offsetMs = 0;
  let cueIndex = 1;
  for (const beat of beats.beats) {
    const alignmentPath = `${dir}/${beat.id}.alignment.json`;
    const alignment = JSON.parse(await readFile(alignmentPath, 'utf8').catch(() => {
      throw new Error(`${alignmentPath} is missing — run a full render (no beat id) once`);
    }));
    beat.startMs = offsetMs;
    const block = toSrt(alignment, { offsetSeconds: offsetMs / 1000, firstIndex: cueIndex });
    cueIndex += countSrtCues(block);
    // A blank line between beats as well as between cues. Without it the first cue of every beat
    // is glued to the last cue of the one before — nine of a hundred and three in the ore plant,
    // and strictly not an .srt file at all, however forgiving most players happen to be.
    srt += (srt ? '\n' : '') + block;
    offsetMs += beat.measuredMs;
  }
  beats.totalMs = offsetMs;
  return { srt, totalMs: offsetMs };
}

/**
 * The audible gaps in a rendered beat: where the voice actually stopped, and for how long.
 *
 * <p>Phrasing is otherwise the one part of the pipeline that can only be judged by ear. The
 * alignment already says when every character was spoken, so a requested pause is checkable —
 * "there should be a break after 'made of'" becomes a number rather than another listen-through.
 *
 * <p>The silence is held *by* a character, not left between two: ElevenLabs returns a contiguous
 * timeline, and a pause shows up as a space or a comma that lasts 700 ms. Measuring the gaps
 * between characters instead finds nothing at all, in a beat that pauses seven times.
 *
 * @param minMs ignore anything shorter; below ~150 ms nothing reads as a pause
 */
export function pauses(alignment, { minMs = 200, context = 18 } = {}) {
  if (!alignment) return [];
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  const text = chars.join('');

  const found = [];
  for (let i = 0; i < chars.length; i++) {
    if (!/[\s,.;:—–-]/.test(chars[i])) continue;
    const heldMs = Math.round((ends[i] - starts[i]) * 1000);
    if (heldMs < minMs) continue;
    // Runs of silence spanning "., " land on several characters in a row; keep the longest.
    const previous = found[found.length - 1];
    if (previous && i - previous.index <= 2) {
      if (heldMs <= previous.ms) continue;
      found.pop();
    }
    found.push({
      index: i,
      ms: heldMs,
      atMs: Math.round(starts[i] * 1000),
      after: text.slice(Math.max(0, i - context), i).trim(),
      before: text.slice(i + 1, i + 1 + context).trim(),
    });
  }
  return found;
}

/** How many cues a subtitle block contains, so the next beat can carry on numbering. */
export function countSrtCues(srt) {
  return srt ? srt.split('\n\n').filter((block) => block.trim()).length : 0;
}

/**
 * Where one episode's audio lives.
 *
 * Beat ids are only unique inside an episode — every episode here starts at `b0` — so a single
 * flat `out/voice/` means the second episode rendered silently overwrites the first one's audio,
 * its alignments and its subtitles. The directory follows the beats file instead:
 * `script/pilot.beats.json` speaks into `out/voice/pilot/`.
 */
export function voiceDir(beatsPath) {
  const name = beatsPath.split('/').pop().replace(/\.beats\.json$/, '').replace(/\.json$/, '');
  return `out/voice/${name}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Flags are not positions: --resume sitting where a beat id goes used to be read as the
  // name of a beat, and the run died complaining there was no beat called "--resume".
  const [mode, beatsPath, beatId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!mode || !beatsPath) {
    throw new Error('usage: node tools/render-voice.mjs <audition|render> <beats.json> [beatId]');
  }

  const key = await apiKey();
  const beats = JSON.parse(await readFile(beatsPath, 'utf8'));

  if (mode === 'audition') {
    const beat = beatId ? beats.beats.find((b) => b.id === beatId) : beats.beats[0];
    if (!beat) throw new Error(`no beat ${beatId} in ${beatsPath}`);
    const auditionDir = `out/audition/${voiceDir(beatsPath).split('/').pop()}`;
    await mkdir(auditionDir, { recursive: true });
    console.log(`auditioning beat "${beat.id}" (${beat.text.length} characters) with ${AUDITION_VOICES.length} voices\n`);
    for (const voice of AUDITION_VOICES) {
      const out = `${auditionDir}/${beat.id}-${voice.name}.mp3`;
      const result = await speak({ text: beat.text, voiceId: voice.id, out, key });
      console.log(`  ${voice.name.padEnd(9)} ${String(result.durationMs).padStart(6)} ms  ${voice.note}`);
    }
    console.log(`\nfiles in ${auditionDir}/`);
    process.exit(0);
  }

  if (mode === 'render') {
    const voiceId = beats.voiceId ?? process.env.ELEVENLABS_VOICE_ID;
    if (!voiceId) throw new Error(`set "voiceId" in ${beatsPath} (or ELEVENLABS_VOICE_ID) first`);
    const dir = voiceDir(beatsPath);
    await mkdir(dir, { recursive: true });
    // Every beat costs characters, and a render that stops halfway — a quota runs out, a request
    // fails — should not charge for the half that already worked when it is started again. Off by
    // default: a beat whose text has been edited must be re-spoken, and silently keeping the old
    // audio for it would be worse than the cost.
    const resume = process.argv.includes('--resume');

    // Naming a beat re-speaks only that one. Text-to-speech is not deterministic, so re-rendering
    // the whole episode to fix one sentence rerolls every other beat's phrasing and length for no
    // reason — and the point of the project is that changing a sentence is a small operation.
    const toRender = beatId ? beats.beats.filter((b) => b.id === beatId) : beats.beats;
    if (!toRender.length) throw new Error(`no beat ${beatId} in ${beatsPath}`);
    if (beatId) console.log(`re-rendering ${beatId} only; other beats keep their measured audio\n`);

    for (const beat of toRender) {
      const out = `${dir}/${beat.id}.mp3`;
      if (resume && existsSync(out) && existsSync(`${dir}/${beat.id}.alignment.json`)) {
        beat.measuredMs = await durationMs(out);
        console.log(`${beat.id}: kept, ${beat.measuredMs} ms  -> ${out}`);
        continue;
      }
      const result = await speak({ text: beat.text, voiceId, out, key });
      beat.measuredMs = result.durationMs;
      const drift = result.durationMs - beat.plannedMs;
      console.log(`${beat.id}: ${result.durationMs} ms (estimate ${beat.plannedMs} ms, ${drift >= 0 ? '+' : ''}${drift})  -> ${out}`);

      // Kept alongside the audio so phrasing can be inspected later without spending another
      // render — the alignment is the only record of where the voice actually breathed, and it is
      // what lets an untouched beat keep its subtitles when a neighbour is re-rendered.
      await writeFile(`${dir}/${beat.id}.alignment.json`, JSON.stringify(result.alignment));
      for (const p of pauses(result.alignment, { minMs: 300 })) {
        console.log(`      ${String(p.ms).padStart(4)} ms pause after "…${p.after}" before "${p.before}…"`);
      }
    }

    // Offsets and subtitles are rebuilt across every beat, rendered or not: one beat growing by a
    // second moves everything after it.
    const { srt, totalMs: offsetMs } = await subtitlesFor(beats, dir);
    console.log(`\ntotal narration: ${offsetMs} ms`);

    // One continuous track, so the take can be muxed in a single ffmpeg call.
    const listPath = `${dir}/beats.txt`;
    await writeFile(listPath, beats.beats.map((b) => `file '${process.cwd()}/${dir}/${b.id}.mp3'`).join('\n'));
    await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', `${dir}/narration.mp3`]);
    console.log(`joined narration in ${dir}/narration.mp3`);
    await writeFile(beatsPath, JSON.stringify(beats, null, 2) + '\n');
    await writeFile(`${dir}/subtitles.srt`, srt);
    console.log(`\nmeasured durations written back to ${beatsPath}`);
    console.log(`subtitles in ${dir}/subtitles.srt`);
    process.exit(0);
  }

  throw new Error(`unknown mode: ${mode}`);
}
