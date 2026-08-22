/**
 * The words, and what the voice did with them.
 *
 * Two things are shown next to each beat that used to take a terminal to find out: whether the
 * text has been rewritten since it was last spoken — asked of the alignment rather than of a
 * modification time — and where the voice actually paused, which is the only reliable way to tell
 * a sentence break from a comma.
 */

import { useEffect, useState } from 'react';
import { mediaUrl, op } from '../api';
import { useStudio } from '../store';

export function Script() {
  const { project, say } = useStudio();
  const [beats, setBeats] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pauses, setPauses] = useState<Record<string, any[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    if (!project) return;
    const read = await op('beats_read', { slug: project.slug });
    setBeats(read);
    setDraft({});
  };
  useEffect(() => { load().catch((error) => say(error.message, 'bad')); }, [project?.slug]);

  if (!project || !beats) return <p className="dim">Reading the beats…</p>;

  const voiceFolder = `out/voice/${project.documents.beats.split('/').pop()!.replace('.beats.json', '')}`;

  const save = async (id: string) => {
    setBusy(id);
    try {
      await op('beat_set', { slug: project.slug, id, text: draft[id] });
      say(`${id} rewritten — it will need speaking again`, 'good');
      await load();
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const speak = async (id?: string) => {
    setBusy(id ?? 'all');
    try {
      const result = await op('voice_render', { slug: project.slug, beat: id });
      say(result.exitCode === 0 ? `spoken${id ? ' ' + id : ''}` : 'the render failed — see the log',
        result.exitCode === 0 ? 'good' : 'bad');
      await load();
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const showPauses = async (id: string) => {
    try {
      const found = await op('voice_pauses', { slug: project.slug, beat: id });
      setPauses({ ...pauses, [id]: found.pauses });
    } catch (error: any) {
      say(error.message, 'bad');
    }
  };

  return (
    <>
      <h1>Text &amp; voice</h1>
      <p className="lede">
        {beats.beats.length} beats · {beats.totalMs ? `${(beats.totalMs / 1000).toFixed(1)} s measured` : 'not yet measured'}
        {beats.voiceName ? ` · ${beats.voiceName}` : ''}
      </p>
      <div className="row wrap" style={{ marginBottom: '1rem' }}>
        <button className="primary" disabled={busy !== null} onClick={() => speak()}>
          {busy === 'all' ? 'speaking…' : 'Speak every beat'}
        </button>
        <button disabled={busy !== null} onClick={async () => {
          const beat = prompt('Audition which beat?', beats.beats[0].id);
          if (!beat) return;
          setBusy('audition');
          try {
            await op('voice_audition', { slug: project.slug, beat });
            say('auditions are in out/audition/', 'good');
          } finally { setBusy(null); }
        }}>Audition voices</button>
        <span className="faint mono">{voiceFolder}/</span>
      </div>

      {beats.beats.map((beat: any) => {
        const changed = draft[beat.id] !== undefined && draft[beat.id] !== beat.text;
        return (
          <div className="card" key={beat.id} style={{ marginBottom: '0.7rem' }}>
            <div className="row">
              <strong className="mono">{beat.id}</strong>
              <span className={`pill ${beat.state === 'fresh' ? 'good' : beat.state === 'stale' ? 'warn' : ''}`}>
                {beat.state}
              </span>
              <span className="faint">{beat.why}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <span className="mono dim">
                {beat.measuredMs ? `${(beat.measuredMs / 1000).toFixed(1)} s` : `est. ${(beat.plannedMs / 1000).toFixed(0)} s`}
                {beat.measuredMs && beat.plannedMs
                  ? ` (${beat.measuredMs - beat.plannedMs >= 0 ? '+' : ''}${beat.measuredMs - beat.plannedMs} ms)` : ''}
              </span>
            </div>

            <textarea
              style={{ width: '100%', minHeight: '5.5rem', marginTop: '0.5rem', resize: 'vertical' }}
              value={draft[beat.id] ?? beat.text}
              onChange={(event) => setDraft({ ...draft, [beat.id]: event.target.value })}
            />

            <div className="row wrap" style={{ marginTop: '0.5rem' }}>
              <button disabled={!changed || busy !== null} className={changed ? 'primary' : ''}
                onClick={() => save(beat.id)}>Save</button>
              <button disabled={busy !== null} onClick={() => speak(beat.id)}>
                {busy === beat.id ? 'speaking…' : 'Speak just this'}
              </button>
              {beat.state === 'fresh' && <button onClick={() => showPauses(beat.id)}>Where it breathes</button>}
              {beat.state === 'fresh' && (
                <audio controls preload="none" style={{ height: '1.9rem' }}
                  src={mediaUrl(`${voiceFolder}/${beat.id}.mp3`)} />
              )}
            </div>

            {pauses[beat.id] && (
              <div className="log" style={{ marginTop: '0.5rem', maxHeight: '9rem' }}>
                {pauses[beat.id].length === 0 ? 'no pause over 300 ms' : pauses[beat.id].map((pause: any, i: number) => (
                  <div key={i}>{String(pause.ms).padStart(5)} ms after “…{pause.after}” before “{pause.before}…”</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
