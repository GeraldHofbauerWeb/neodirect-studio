/**
 * The episode on a clock: what is spoken, what the camera does, what is built, and what happens
 * to the world — four lanes, one time axis, a playhead across all of them.
 *
 * The lanes are the whole point. A storyboard is a flat list of cues in the order somebody wrote
 * them, and a picture of that list is confetti; sorted by kind it becomes an episode you can read.
 * "At two minutes thirteen the camera is arcing past the boiler while the sorting bay goes up and
 * the voice is on its third sentence" is a sentence the flat list cannot say.
 *
 * Cues are placed as fractions of a beat rather than at milliseconds, because the milliseconds are
 * not knowable until the voice comes back — so that is what dragging edits, even though the axis
 * is drawn in seconds. When a beat is re-spoken and grows, its cues keep their place in the
 * sentence rather than sliding off the end of it.
 *
 * A beat that has never been spoken is drawn at its estimate and hatched, because a timeline drawn
 * from guesses that looks like a timeline drawn from measurements is worse than no timeline.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { op } from '../api';
import { useStudio } from '../store';
import { Viewport } from '../viewport/viewport';
import { ShadingSwitch } from '../viewport/shading';

const CUE_COLOURS: Record<string, string> = {
  place: '#7dd3fc', camera: '#c084fc', showFilter: '#fbbf24', screen: '#a3e635',
  fill: '#5eead4', materialsChest: '#fb923c', entities: '#93c5fd', setBlocks: '#f472b6',
  use: '#facc15', reseat: '#f87171', gameMode: '#94a3b8', marker: '#64748b',
};

const LANES: { id: 'narration' | 'camera' | 'build' | 'world'; label: string; height: number }[] = [
  { id: 'narration', label: 'Narration', height: 8 },
  { id: 'camera', label: 'Camera', height: 2.6 },
  { id: 'build', label: 'Build', height: 2.6 },
  { id: 'world', label: 'World', height: 2.2 },
];

const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function Timeline() {
  const { project, say, scrubMs, setScrub, director, blocks, colors, parts, atlas, shading, times } = useStudio();
  const [track, setTrack] = useState<any>(null);
  const [cues, setCues] = useState<any>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Wide enough that a sentence is readable rather than a stripe. The episode is then far
  // wider than the window, which is what the scrollbar is for — a timeline you can read is
  // worth more than one that fits.
  const [pxPerSecond, setPxPerSecond] = useState(16);
  const [alsoInGame, setAlsoInGame] = useState(false);
  const surface = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (!project) return;
    const [lanes, list] = await Promise.all([
      op('timeline_track', { slug: project.slug }),
      op('cues_list', { slug: project.slug }),
    ]);
    setTrack(lanes);
    setCues(list);
  };
  useEffect(() => { load().catch((error) => say(error.message, 'bad')); }, [project?.slug]);

  const total = track?.totalMs ?? 1;
  const width = (total / 1000) * pxPerSecond;
  const x = (ms: number) => (ms / 1000) * pxPerSecond;

  /** Where a beat starts, so the ruler can mark the boundaries the cues are actually written in. */
  const beatStarts = useMemo(() => {
    if (!track) return [];
    let at = 0;
    return track.beats.map((beat: any) => {
      const from = beat.startMs ?? at;
      const length = beat.measuredMs ?? beat.plannedMs ?? 0;
      at = from + length;
      return { ...beat, fromMs: from, toMs: at, estimated: beat.state !== 'fresh' };
    });
  }, [track]);

  if (!project) return null;
  if (!track) return <div style={{ padding: '1rem' }} className="dim">Reading the storyboard…</div>;

  const cue = chosen !== null ? cues?.cues[chosen] : null;
  // What has not gone down yet at the playhead. The viewport fades these, so dragging the
  // playhead builds the plant — which is the whole reason the build lane is worth having.
  const future = blocks
    .filter((block) => times && (times[block.i] === undefined || times[block.i] > scrubMs))
    .map((block) => block.i);
  const nowBeat = beatStarts.find((b: any) => scrubMs >= b.fromMs && scrubMs < b.toMs);
  const nowLine = track.lanes.narration.find((l: any) => scrubMs >= l.fromMs && scrubMs < l.toMs);

  /** Milliseconds under a pointer, taking the scroll and the lane labels into account. */
  const msAt = (clientX: number) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return 0;
    const within = clientX - box.left + (surface.current?.scrollLeft ?? 0) - LABEL_WIDTH;
    return Math.max(0, Math.min(total, (within / pxPerSecond) * 1000));
  };

  const scrubTo = async (ms: number) => {
    setScrub(Math.round(ms));
    // Follow it. Clicking a sentence three minutes in and watching the visible window not move is
    // the same experience as the click not working.
    const view = surface.current;
    if (view) {
      const at = LABEL_WIDTH + x(ms);
      const margin = 120;
      if (at < view.scrollLeft + LABEL_WIDTH + margin || at > view.scrollLeft + view.clientWidth - margin) {
        view.scrollTo({ left: Math.max(0, at - view.clientWidth / 2), behavior: 'smooth' });
      }
    }
    if (!alsoInGame || !director.up || director.running) return;
    try {
      await op('scrub', { slug: project.slug, take: useStudio.getState().take ?? undefined, ms: Math.round(ms) });
    } catch (error: any) {
      say(error.message, 'bad');
    }
  };

  /** Dragging a cue moves it inside whichever beat it lands in — never to a raw millisecond. */
  const dragTo = async (index: number, clientX: number) => {
    const ms = msAt(clientX);
    const beat = beatStarts.find((b: any) => ms >= b.fromMs && ms < b.toMs) ?? beatStarts[beatStarts.length - 1];
    if (!beat) return;
    const at = Math.round(((ms - beat.fromMs) / Math.max(1, beat.toMs - beat.fromMs)) * 1000) / 1000;
    setBusy(true);
    try {
      await op('cue_move', { slug: project.slug, index, beat: beat.id, at: Math.max(0, Math.min(1, at)) });
      await load();
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split" style={{ height: '100%' }}>
      <div className="main" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <h1 style={{ marginBottom: '0.2rem' }}>Timeline</h1>
        <p className="lede" style={{ marginTop: 0 }}>
          {clock(total)} · {track.lanes.narration.length} sentences, {track.lanes.camera.length} camera
          {' '}moves, {track.lanes.build.length} placements
          {beatStarts.some((b: any) => b.estimated) ? ' — some beats are still estimates' : ''}
          {track.unplaced ? ` · ${track.unplaced} blocks no cue places` : ''}
        </p>

        <div className="row wrap" style={{ marginBottom: '0.6rem' }}>
          <button className="primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const check = await op('storyboard_check', { slug: project.slug });
              if (!check.ok) { say('the storyboard does not check out — see the log below', 'bad'); setTrack({ ...track, check }); return; }
              await op('timeline_compile', { slug: project.slug });
              say('compiled against the measured narration', 'good');
            } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(false); }
          }}>Check &amp; compile</button>
          <button onClick={() => load()}>Reload</button>
          <span className="spacer" />
          <span className="mono faint" style={{ fontSize: 11 }}>
            {clock(scrubMs)}{nowBeat ? ` · ${nowBeat.id}` : ''}
            {/* How much of the build stands at the playhead — the number the picture below is of. */}
            {times ? ` · ${blocks.length - future.length}/${blocks.length} blocks` : ''}
          </span>
          <label className="row faint" style={{ fontSize: 11, gap: '0.25rem' }}
            title={director.up ? 'move the world in the game to match the playhead'
              : 'the instance is closed'}>
            <input type="checkbox" checked={alsoInGame} disabled={!director.up}
              onChange={(event) => setAlsoInGame(event.target.checked)} />
            also in the game
          </label>
          <button onClick={() => setPxPerSecond((p) => Math.max(1.5, p / 1.5))} title="zoom out">−</button>
          <button onClick={() => setPxPerSecond((p) => Math.min(80, p * 1.5))} title="zoom in">+</button>
        </div>

        {nowLine && (
          <p style={{ margin: '0 0 0.5rem', fontSize: 13 }}>
            <span className="faint mono" style={{ fontSize: 11 }}>{nowLine.beat} </span>
            {nowLine.text}
          </p>
        )}

        <div ref={surface} style={{
          position: 'relative', overflowX: 'auto', overflowY: 'hidden', flex: '0 0 auto',
          border: '1px solid var(--line)', borderRadius: 7, background: 'var(--bg-sunken)',
        }}>
          <div style={{
            position: 'relative', width: width + LABEL_WIDTH,
            display: 'flex', flexDirection: 'column',
          }}>
            <Ruler beats={beatStarts} total={total} x={x} onScrub={(clientX: number) => scrubTo(msAt(clientX))} />

            {LANES.map((lane) => (
              <div key={lane.id} style={{
                position: 'relative', minHeight: `${lane.height}rem`,
                flex: `0 0 ${lane.height}rem`,
                borderBottom: '1px solid var(--line)',
              }}>
                <div className="faint" style={{
                  position: 'sticky', left: 0, zIndex: 3, width: LABEL_WIDTH, float: 'left',
                  height: '100%', fontSize: 10, padding: '0.25rem 0.5rem',
                  background: 'var(--bg-sunken)', borderRight: '1px solid var(--line)',
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>{lane.label}</div>

                {lane.id === 'narration'
                  ? track.lanes.narration.map((line: any, n: number) => (
                    <Bar key={n} left={LABEL_WIDTH + x(line.fromMs)} width={Math.max(2, x(line.toMs - line.fromMs))}
                      colour="#94a3b8" title={`${line.beat} · ${clock(line.fromMs)}\n${line.text}`}
                      onClick={() => scrubTo(line.fromMs)} text={line.text} lines={6} />
                  ))
                  : track.lanes[lane.id].filter((entry: any) => entry.timed).map((entry: any) => (
                    <Bar key={entry.index}
                      left={LABEL_WIDTH + x(entry.fromMs)}
                      width={Math.max(3, x(entry.toMs - entry.fromMs))}
                      colour={CUE_COLOURS[entry.type] ?? '#888'}
                      chosen={chosen === entry.index}
                      draggable
                      onDragEnd={(event: DragEvent) => dragTo(entry.index, event.clientX)}
                      onClick={() => setChosen(entry.index)}
                      title={`${entry.type} · ${entry.beat ?? 'absolute'} · ${clock(entry.fromMs)}`
                        + `–${clock(entry.toMs)}${entry.ease ? ` · ${entry.ease}` : ''}`}
                      text={entry.label}
                      badge={entry.blocks ? `${entry.blocks}` : entry.keyframes ? `${entry.keyframes} kf` : undefined}
                    />
                  ))}
              </div>
            ))}

            {/* The playhead crosses every lane, which is the only way to read one against another. */}
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: LABEL_WIDTH + x(scrubMs),
              width: 1, background: '#f87171', pointerEvents: 'none', zIndex: 4,
            }} />
          </div>
        </div>

        {/*
          The build, at the playhead. Under the lanes rather than in another panel: "when is this
          built" and "what does that look like" are one question, and answering them in two places
          means holding a picture in your head while you walk between them.
        */}
        <div style={{ position: 'relative', flex: 1, minHeight: '14rem', marginTop: '0.6rem',
          border: '1px solid var(--line)', borderRadius: 7, overflow: 'hidden' }}>
          <ShadingSwitch hasTimes={!!times} />
          <Viewport blocks={blocks} colors={colors} parts={parts} atlas={atlas} shading={shading}
            times={times} ghost={future} origin={project.origin} />
        </div>

        {track.check && <><h2>Check</h2><div className="log">{track.check.lines.join('\n')}</div></>}
      </div>

      <div className="side">
        {!cue ? (
          <>
            <p className="faint">Pick a cue.</p>
            {track.unplacedByType && Object.keys(track.unplacedByType).length > 0 && (
              <>
                <h2 style={{ marginTop: '1rem' }}>Nobody places these</h2>
                <p className="dim" style={{ fontSize: 12 }}>
                  A block no cue claims is a block no beat ever builds, and nothing in a take log
                  would say so.
                </p>
                <table>
                  <tbody>
                    {Object.entries(track.unplacedByType).map(([id, count]: any) => (
                      <tr key={id}><td className="mono">{id}</td><td>×{count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        ) : (
          <Inspector cue={cue} index={chosen!} slug={project.slug} beats={track.beats}
            sentence={track.lanes.narration.find((l: any) =>
              cue.atMsResolved !== null && l.fromMs <= cue.atMsResolved && l.toMs > cue.atMsResolved)}
            onChange={load} />
        )}
      </div>
    </div>
  );
}

/** Room for the lane names, which stay put while the time axis scrolls under them. */
const LABEL_WIDTH = 74;

/** Seconds along the top, and the beat boundaries the cues are actually written against. */
function Ruler({ beats, total, x, onScrub }: any) {
  // A tick every ten seconds is right at the default zoom and absurd at either end of it, so the
  // step follows the scale: whatever keeps ticks about eighty pixels apart.
  const perSecond = x(1000);
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * perSecond > 55) ?? 600;
  const ticks = [];
  for (let second = 0; second * 1000 <= total; second += step) ticks.push(second);

  return (
    <div style={{ position: 'relative', height: '2.6rem', borderBottom: '1px solid var(--line-bright)' }}
      onPointerDown={(event) => onScrub(event.clientX)}
      onPointerMove={(event) => event.buttons === 1 && onScrub(event.clientX)}>
      <div className="faint" style={{
        position: 'sticky', left: 0, zIndex: 3, width: LABEL_WIDTH, float: 'left', height: '100%',
        fontSize: 10, padding: '0.25rem 0.5rem', background: 'var(--bg-sunken)',
        borderRight: '1px solid var(--line)',
      }}>TIME</div>

      {beats.map((beat: any) => (
        <div key={beat.id} style={{
          position: 'absolute', left: LABEL_WIDTH + x(beat.fromMs), top: 0, bottom: 0,
          width: Math.max(1, x(beat.toMs - beat.fromMs)), borderLeft: '1px solid var(--line-bright)',
          // Hatched when the length is a guess rather than a measurement.
          background: beat.estimated
            ? 'repeating-linear-gradient(45deg, rgba(251,191,36,0.09) 0 6px, transparent 6px 12px)'
            : 'transparent',
        }}>
          <div className="mono" style={{
            fontSize: 10, padding: '1.35rem 0 0 0.25rem',
            color: beat.estimated ? 'var(--warn)' : 'var(--text-faint)',
          }}>{beat.id}{beat.estimated ? ' ~' : ''}</div>
        </div>
      ))}

      {ticks.map((second) => (
        <div key={second} className="mono faint" style={{
          position: 'absolute', left: LABEL_WIDTH + x(second * 1000), top: 0,
          fontSize: 10, padding: '0.15rem 0 0 0.2rem', borderLeft: '1px solid var(--line)',
          height: '1.1rem', pointerEvents: 'none',
        }}>{clock(second * 1000)}</div>
      ))}
    </div>
  );
}

/** One thing that lasts: a sentence, a camera move, a placement. */
function Bar({ left, width, colour, text, badge, title, chosen, lines = 1, ...rest }: any) {
  return (
    <div {...rest} title={title}
      style={{
        position: 'absolute', left, width, top: '0.2rem', bottom: '0.2rem',
        background: chosen ? '#2b3442' : 'rgba(255,255,255,0.035)',
        borderLeft: `3px solid ${colour}`,
        borderRadius: 3, overflow: 'hidden', cursor: 'pointer',
        padding: '0.1rem 0.3rem', fontSize: 11, lineHeight: 1.25,
        color: 'var(--text-dim)',
        display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical',
      }}>
      {width >= 26 && badge && <span className="faint mono" style={{ marginRight: '0.3rem' }}>{badge}</span>}
      {width >= 26 ? text : null}
    </div>
  );
}

/**
 * One cue, with the fields its type actually has.
 *
 * Twelve cue types, each with its own shape, and the reason they are spelled out rather than shown
 * as raw JSON is that the shape is where the mistakes live: a screen cue with no position, a place
 * cue whose selector claims nothing, a camera cue eased the wrong way for a follow run.
 */
function Inspector({ cue, index, slug, beats, sentence, onChange }: any) {
  const say = useStudio((s) => s.say);
  const select = useStudio((s) => s.select);
  const [draft, setDraft] = useState<Record<string, any>>({});
  useEffect(() => setDraft({}), [index]);

  const value = (key: string) => (draft[key] !== undefined ? draft[key] : cue[key]);
  const set = (key: string, next: any) => setDraft({ ...draft, [key]: next });

  const save = async () => {
    try {
      await op('cue_update', { slug, index, fields: draft });
      say('cue changed', 'good');
      setDraft({});
      onChange();
    } catch (error: any) { say(error.message, 'bad'); }
  };

  const preview = async () => {
    try {
      const found = await op('selector_resolve', { slug, blocks: cue.blocks, upToCue: index });
      select(found.indices);
      say(`${found.count} blocks · ${found.describe}`, 'good');
    } catch (error: any) { say(error.message, 'bad'); }
  };

  const field = (key: string, label: string, kind: 'text' | 'number' = 'text') => (
    <label style={{ display: 'block', marginBottom: '0.5rem' }}>
      <div className="faint" style={{ fontSize: 11 }}>{label}</div>
      <input style={{ width: '100%' }} type={kind}
        value={value(key) ?? ''}
        onChange={(event) => set(key, kind === 'number' ? Number(event.target.value) : event.target.value)} />
    </label>
  );

  return (
    <>
      <div className="row">
        <strong>{cue.type}</strong>
        <span className="mono faint">#{index}</span>
      </div>
      {cue._what && <p className="dim" style={{ fontSize: 12 }}>{cue._what}</p>}
      {/* What is being said while this cue runs — the thing it was written to sit under. */}
      {sentence && (
        <p className="faint" style={{ fontSize: 11, borderLeft: '2px solid var(--line-bright)', paddingLeft: '0.5rem' }}>
          under: “{sentence.text}”
        </p>
      )}

      <label style={{ display: 'block', marginBottom: '0.5rem' }}>
        <div className="faint" style={{ fontSize: 11 }}>beat</div>
        <select style={{ width: '100%' }} value={value('beat') ?? ''} onChange={(event) => set('beat', event.target.value)}>
          <option value="">— absolute —</option>
          {beats.map((beat: any) => <option key={beat.id} value={beat.id}>{beat.id}</option>)}
        </select>
      </label>
      {value('beat') && field('at', 'at (fraction of the beat)', 'number')}
      {value('beat') && cue.type === 'camera' && field('until', 'until (fraction)', 'number')}
      {!value('beat') && field('atMs', 'atMs', 'number')}

      {cue.type === 'place' && (
        <>
          <div className="faint" style={{ fontSize: 11 }}>blocks</div>
          <div className="mono" style={{ marginBottom: '0.35rem' }}>{JSON.stringify(cue.blocks)}</div>
          {cue.blocksResolved && (
            <div className="dim" style={{ marginBottom: '0.5rem' }}>
              {cue.blocksResolved.count} blocks · {cue.blocksResolved.describe}
            </div>
          )}
          <button onClick={preview} style={{ marginBottom: '0.6rem' }}>Show them</button>
          {field('spanMs', 'spanMs — spread over', 'number')}
          {field('staggerMs', 'staggerMs — one every', 'number')}
        </>
      )}

      {cue.type === 'camera' && (
        <>
          {field('durationMs', 'durationMs', 'number')}
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <div className="faint" style={{ fontSize: 11 }}>ease</div>
            <select style={{ width: '100%' }} value={value('ease') ?? 'inOut'} onChange={(event) => set('ease', event.target.value)}>
              <option value="inOut">inOut — settles at both ends</option>
              <option value="linear">linear — one leg of a longer journey</option>
            </select>
          </label>
          <div className="faint" style={{ fontSize: 11 }}>{cue.keyframes?.length ?? 0} keyframes</div>
        </>
      )}

      {['screen', 'showFilter', 'fill', 'use', 'setBlocks', 'materialsChest'].includes(cue.type) && cue.pos && (
        <div className="mono" style={{ marginBottom: '0.5rem' }}>pos {cue.pos.join(', ')}</div>
      )}
      {cue.type === 'screen' && field('action', 'action (open / close)')}
      {cue.type === 'gameMode' && field('mode', 'mode')}
      {cue.type === 'marker' && field('label', 'label')}
      {cue.type === 'entities' && field('filter', 'filter')}
      {cue.type === 'reseat' && (
        <div className="mono faint" style={{ marginBottom: '0.5rem' }}>
          {[].concat(cue.ofType ?? []).length} block types
        </div>
      )}

      <div className="row" style={{ marginTop: '0.8rem' }}>
        <button className="primary" disabled={!Object.keys(draft).length} onClick={save}>Save</button>
        <button className="danger" onClick={async () => {
          if (!confirm(`Delete cue ${index} (${cue.type})?`)) return;
          await op('cue_delete', { slug, index });
          onChange();
        }}>Delete</button>
      </div>
    </>
  );
}
