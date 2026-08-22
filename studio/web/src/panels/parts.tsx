/**
 * Which blocks are which assembly.
 *
 * The manifest is rules, not indices, and the rules are what is edited here — an id list, a box, a
 * single position. Saving resolves them again, and a block belonging to no part fails rather than
 * warns: it would be a block no beat ever builds, and no take log would ever mention it.
 */

import { useEffect, useState } from 'react';
import { op } from '../api';
import { useStudio, PART_COLOURS } from '../store';
import { Viewport } from '../viewport/viewport';

export function Parts() {
  const { project, blocks, colors, parts, selection, select, say } = useStudio();
  const [manifest, setManifest] = useState<any>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const load = async () => {
    if (!project) return;
    setManifest(await op('parts_read', { slug: project.slug }));
  };
  useEffect(() => { load().catch((error) => say(error.message, 'bad')); }, [project?.slug]);

  if (!project) return null;

  const resolve = async () => {
    setBusy(true);
    try {
      const result = await op('parts_resolve', { slug: project.slug });
      setLog(result.lines);
      say(result.ok ? 'every block belongs to a part' : 'some blocks belong to no part', result.ok ? 'good' : 'bad');
      await load();
    } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(false); }
  };

  const edit = async (index: number, field: string, value: unknown) => {
    setBusy(true);
    try {
      await op('parts_write', {
        slug: project.slug,
        ops: [{ op: 'set', pointer: `/parts/${index}/${field}`, value }],
        resolve: true,
      });
      say('resolved again', 'good');
      await load();
    } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(false); }
  };

  const counts = manifest?.resolved?.counts ?? {};

  return (
    <div className="split" style={{ height: '100%' }}>
      <div style={{ position: 'relative', minHeight: 0 }}>
        <Viewport blocks={blocks} colors={colors} parts={parts} colourBy="part"
          selection={selection} origin={project.origin}
          onPick={(index) => {
            select(index === null ? [] : [index]);
            if (index !== null) {
              const owner = Object.entries(parts).find(([, indices]) => indices.includes(index));
              const block = blocks.find((b) => b.i === index);
              say(`${block?.id ?? '?'} at ${block?.pos.join(', ')} · ${owner ? owner[0] : 'no part'}`,
                owner ? 'plain' : 'bad');
            }
          }} />
      </div>

      <div className="side">
        <h2 style={{ marginTop: 0 }}>Assemblies</h2>
        <p className="faint" style={{ fontSize: 11 }}>
          Matched in order; the first part to claim a block keeps it. The housing goes first so the
          boxes after it do not have to carve walls out of themselves, and the drive goes last so
          “every shaft anywhere” cannot steal the washing station's gearbox.
        </p>

        {manifest?.manifest?.parts?.map((part: any, index: number) => (
          <div key={part.name} className="card" style={{ marginBottom: '0.5rem', padding: '0.6rem' }}>
            <div className="row" onClick={() => { setChosen(chosen === part.name ? null : part.name); select(parts[part.name] ?? []); }}
              style={{ cursor: 'pointer' }}>
              <span className="dot" style={{ background: PART_COLOURS[index % PART_COLOURS.length] }} />
              <strong>{part.name}</strong>
              <span className="mono faint">{counts[part.name] ?? 0}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <span className="faint mono">{part.letter}</span>
            </div>
            {chosen === part.name && (
              <>
                <div className="dim" style={{ fontSize: 12, margin: '0.35rem 0' }}>{part.title}</div>
                {part.match.map((rule: any, r: number) => (
                  <div key={r} style={{ marginBottom: '0.4rem' }}>
                    {rule.ids && (
                      <div className="mono faint" style={{ fontSize: 11 }}>{rule.ids.length} ids</div>
                    )}
                    {rule.box && (
                      <label>
                        <div className="faint" style={{ fontSize: 11 }}>box</div>
                        <input style={{ width: '100%' }} className="mono" defaultValue={JSON.stringify(rule.box)}
                          onBlur={(event) => {
                            try {
                              const box = JSON.parse(event.target.value);
                              edit(index, `match/${r}/box`, box);
                            } catch { say('that is not a box', 'bad'); }
                          }} />
                      </label>
                    )}
                    {rule.pos && <div className="mono faint" style={{ fontSize: 11 }}>pos {rule.pos.join(', ')}</div>}
                  </div>
                ))}
              </>
            )}
          </div>
        ))}

        <div className="row wrap" style={{ marginTop: '0.6rem' }}>
          <button className="primary" disabled={busy} onClick={resolve}>Resolve again</button>
        </div>

        {manifest?.resolved?.stale?.length > 0 && (
          <p className="pill bad" style={{ display: 'inline-block', marginTop: '0.6rem' }}>
            {manifest.resolved.stale.length} positions no longer exist
          </p>
        )}

        {log.length > 0 && <div className="log" style={{ marginTop: '0.6rem', maxHeight: '14rem' }}>{log.join('\n')}</div>}
      </div>
    </div>
  );
}
