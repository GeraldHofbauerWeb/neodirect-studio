/**
 * Where the build came from, and whether the census still describes it.
 *
 * The clip spec is the document that says what was cut out of the world and what was left behind;
 * the report is what that cut produced. They come apart quietly — the report currently claims
 * eleven hundred blocks for a schematic that has nine hundred and twenty-six, and the narration
 * quotes the report — so the comparison is made here rather than left to memory.
 */

import { useEffect, useState } from 'react';
import { op } from '../api';
import { useStudio } from '../store';

export function SchematicPanel() {
  const { project, say } = useStudio();
  const [report, setReport] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);
  const [clip, setClip] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const load = async () => {
    if (!project) return;
    setReport(await op('schematic_report', { slug: project.slug }));
    setSummary(await op('schematic_blocks', { slug: project.slug, summary: true }));
    if (project.documents.clip) setClip(await op('doc_read', { path: project.documents.clip }));
  };
  useEffect(() => { load().catch((error) => say(error.message, 'bad')); }, [project?.slug]);

  if (!project || !summary) return <p className="dim">Reading the schematic…</p>;

  const run = async (label: string, name: string, params: Record<string, unknown>) => {
    setBusy(label);
    setLog([]);
    try {
      const result: any = await op(name, params);
      setLog(result.lines ?? []);
      say(`${label} done`, 'good');
      await load();
    } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(null); }
  };

  return (
    <>
      <h1>Schematic</h1>
      <p className="lede">
        {summary.blocks} blocks in {summary.size.join(' × ')} · {summary.entities} entities ·
        {' '}{summary.namespaces.join(', ')}
        {summary.sourceOrigin ? ` · cut at ${summary.sourceOrigin.join(', ')}` : ''}
      </p>

      <div className="row wrap">
        <button disabled={busy !== null} onClick={() => run('install', 'schematic_install', {})}>
          Install into the game
        </button>
        {project.documents.clip && (
          <>
            <button disabled={busy !== null} onClick={() => run('dry run', 'clip_run', { slug: project.slug, dryRun: true })}>
              Dry-run the clip
            </button>
            <button className="danger" disabled={busy !== null} onClick={() => {
              if (!confirm('Re-cut the schematic? Every index and position downstream of it moves. A snapshot is taken first.')) return;
              run('clip', 'clip_run', { slug: project.slug });
            }}>Re-cut</button>
          </>
        )}
      </div>

      <h2>Census</h2>
      {!report?.present ? <p className="faint">No report beside the schematic.</p> : (
        <>
          <div className="row">
            <span className={`pill ${report.stale ? 'bad' : 'good'}`}>
              {report.stale ? 'stale' : 'agrees'}
            </span>
            <span className="dim">
              report says {report.report.blocks} blocks, the schematic has {report.blocksNow}
            </span>
          </div>
          {report.stale && (
            <p className="dim" style={{ maxWidth: '62ch' }}>
              Anything the narration took from this report is quoting a build that no longer exists.
              Re-cutting writes it again.
            </p>
          )}
          <table style={{ marginTop: '0.6rem' }}>
            <thead><tr><th>Type</th><th>Count</th></tr></thead>
            <tbody>
              {Object.entries(summary.types).slice(0, 18).map(([id, count]: any) => (
                <tr key={id}><td className="mono">{id}</td><td>{count}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {clip && (
        <>
          <h2>Clip spec</h2>
          <p className="lede">{clip.value._what}</p>
          <table>
            <tbody>
              <tr><td className="faint">origin</td><td className="mono">{clip.value.origin?.join(', ')}</td></tr>
              <tr><td className="faint">boxes</td><td>{clip.value.boxes?.length ?? 0}</td></tr>
              <tr><td className="faint">dropped types</td><td>{clip.value.drop?.length ?? 0}</td></tr>
              <tr><td className="faint">kept as machine</td><td className="mono">{(clip.value.machine ?? []).join(', ') || '—'}</td></tr>
              <tr><td className="faint">reset states</td><td className="mono">{Object.keys(clip.value.resetStates ?? {}).join(', ') || '—'}</td></tr>
              <tr><td className="faint">cleared nbt keys</td><td className="mono">{(clip.value.clearNbtKeys ?? []).join(', ') || '—'}</td></tr>
            </tbody>
          </table>
        </>
      )}

      {log.length > 0 && <><h2>Output</h2><div className="log">{log.join('\n')}</div></>}
    </>
  );
}
