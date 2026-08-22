/**
 * The storyboard, on a clock.
 *
 * Cues are placed as fractions of a beat rather than at milliseconds, because the milliseconds are
 * not knowable until the voice comes back — so that is what is edited here too. Dragging a cue
 * moves it inside its beat; when the beat is re-spoken and grows, the cue keeps its place in the
 * sentence rather than sliding off the end of it.
 *
 * A beat that has never been spoken is drawn at its estimate and marked, because a timeline drawn
 * from guesses that looks like a timeline drawn from measurements is worse than no timeline.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { op } from '../api';
import { useStudio } from '../store';

const CUE_COLOURS: Record<string, string> = {
  place: '#7dd3fc', camera: '#c084fc', showFilter: '#fbbf24', screen: '#a3e635',
  fill: '#5eead4', materialsChest: '#fb923c', entities: '#93c5fd', setBlocks: '#f472b6',
  use: '#facc15', reseat: '#f87171', gameMode: '#94a3b8', marker: '#64748b',
};

export function Timeline() {
  const { project, say } = useStudio();
  const [model, setModel] = useState<any>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const lane = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (!project) return;
    setModel(await op('cues_list', { slug: project.slug }));
  };
  useEffect(() => { load().catch((error) => say(error.message, 'bad')); }, [project?.slug]);

  const beats = model?.beats ?? [];
  const spans = useMemo(() => {
    let at = 0;
    return beats.map((beat: any) => {
      const length = beat.measuredMs ?? beat.plannedMs ?? 20000;
      const span = { id: beat.id, from: at, length, measured: beat.state === 'fresh' };
      at += length;
      return span;
    });
  }, [model]);
  const total = spans.reduce((sum: number, span: any) => sum + span.length, 0) || 1;

  if (!project) return null;
  if (!model) return <div style={{ padding: '1rem' }} className="dim">Reading the storyboard…</div>;

  const cue = chosen !== null ? model.cues[chosen] : null;
  const positionOf = (entry: any) => {
    const span = spans.find((s: any) => s.id === entry.beat);
    if (span && typeof entry.at === 'number') return (span.from + entry.at * span.length) / total;
    if (typeof entry.atMsResolved === 'number') return entry.atMsResolved / total;
    if (typeof entry.atMs === 'number') return entry.atMs / total;
    return null;
  };

  const dragTo = async (index: number, clientX: number) => {
    const box = lane.current?.getBoundingClientRect();
    if (!box) return;
    const ms = Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total;
    const span = spans.find((s: any) => ms >= s.from && ms < s.from + s.length) ?? spans[spans.length - 1];
    const at = Math.round(((ms - span.from) / span.length) * 1000) / 1000;
    setBusy(true);
    try {
      await op('cue_move', { slug: project.slug, index, beat: span.id, at: Math.max(0, Math.min(1, at)) });
      await load();
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split" style={{ height: '100%' }}>
      <div className="main">
        <h1>Timeline</h1>
        <p className="lede">
          {model.cues.length} cues over {(total / 1000).toFixed(0)} s
          {spans.every((s: any) => s.measured) ? ' of measured narration' : ' — some beats are still estimates'}
          {model.unplaced ? ` · ${model.unplaced} blocks no cue places` : ''}
        </p>

        <div className="row wrap" style={{ marginBottom: '0.8rem' }}>
          <button className="primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const check = await op('storyboard_check', { slug: project.slug });
              if (!check.ok) { say('the storyboard does not check out — see the log below', 'bad'); setModel({ ...model, check }); return; }
              await op('timeline_compile', { slug: project.slug });
              say('compiled against the measured narration', 'good');
            } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(false); }
          }}>Check &amp; compile</button>
          <button onClick={() => load()}>Reload</button>
        </div>

        <div ref={lane} style={{ position: 'relative', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--bg-sunken)' }}>
          <div style={{ display: 'flex', height: '1.6rem', borderBottom: '1px solid var(--line)' }}>
            {spans.map((span: any) => (
              <div key={span.id} title={`${span.id} · ${(span.length / 1000).toFixed(1)} s`}
                style={{
                  width: `${(span.length / total) * 100}%`,
                  borderRight: '1px solid var(--line)',
                  padding: '0.15rem 0.4rem', fontSize: 11,
                  color: span.measured ? 'var(--text-dim)' : 'var(--warn)',
                  fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden',
                }}>
                {span.id}{span.measured ? '' : ' ~'}
              </div>
            ))}
          </div>

          <div style={{ position: 'relative', height: '11rem' }}>
            {model.cues.map((entry: any, index: number) => {
              const left = positionOf(entry);
              if (left === null) return null;
              const row = index % 7;
              return (
                <div
                  key={index}
                  draggable
                  onDragEnd={(event) => dragTo(index, event.clientX)}
                  onClick={() => setChosen(index)}
                  title={`${entry.type} · ${entry.beat ?? 'absolute'} ${entry.at ?? ''} ${entry._what ?? ''}`}
                  style={{
                    position: 'absolute',
                    left: `calc(${left * 100}% - 3px)`,
                    top: `${0.4 + row * 1.45}rem`,
                    height: '1.15rem', minWidth: 6,
                    padding: '0 0.3rem',
                    background: chosen === index ? '#2b3442' : 'transparent',
                    borderLeft: `3px solid ${CUE_COLOURS[entry.type] ?? '#888'}`,
                    color: 'var(--text-dim)', fontSize: 11, whiteSpace: 'nowrap',
                    cursor: 'grab', borderRadius: 3,
                  }}>
                  {entry.type}
                  {entry.blocksResolved ? <span className="faint"> ·{entry.blocksResolved.count}</span> : null}
                </div>
              );
            })}
          </div>
        </div>

        {model.unplacedByType && Object.keys(model.unplacedByType).length > 0 && (
          <>
            <h2>Nobody places these</h2>
            <p className="dim">
              A block no cue claims is a block no beat ever builds, and nothing in a take log would say so.
            </p>
            <table>
              <tbody>
                {Object.entries(model.unplacedByType).map(([id, count]: any) => (
                  <tr key={id}><td className="mono">{id}</td><td>×{count}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {model.check && <><h2>Check</h2><div className="log">{model.check.lines.join('\n')}</div></>}
      </div>

      <div className="side">
        {!cue ? <p className="faint">Pick a cue.</p> : (
          <Inspector cue={cue} index={chosen!} slug={project.slug} beats={beats} onChange={load} />
        )}
      </div>
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
function Inspector({ cue, index, slug, beats, onChange }: any) {
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
