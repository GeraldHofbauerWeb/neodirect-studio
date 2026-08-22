/**
 * What is out of date, and the button that fixes it.
 *
 * The pipeline is a chain of derived files and until now the only way to know whether a link still
 * held was to remember. Each stale link here carries the operation that repairs it, so the answer
 * to "the report says eleven hundred blocks and the schematic has nine hundred" is a click rather
 * than a search through shell history.
 */

import { useEffect, useState } from 'react';
import { op } from '../api';
import { useStudio } from '../store';

export function Dashboard() {
  const { project, say, setPanel } = useStudio();
  const [status, setStatus] = useState<any>(null);
  const [running, setRunning] = useState<string | null>(null);

  const load = async () => {
    if (!project) return;
    setStatus(await op('project_doctor', { slug: project.slug }));
  };

  useEffect(() => { load().catch((error) => say(error.message, 'bad')); }, [project?.slug]);

  if (!project || !status) return <p className="dim">Reading the pipeline…</p>;

  const links = status.pipeline.links;
  const stale = links.filter((l: any) => l.state !== 'fresh');
  const narration = status.pipeline.narration;

  const repair = async (fix: any, label: string) => {
    setRunning(label);
    try {
      // Which take a fix belongs to travels with the fix. Two takes can come out of the same
      // generator with different arguments — the arc build and the followed one do — and
      // regenerating one with the other's arguments quietly throws away a day of framing.
      const take = fix.params?.take;
      const map: Record<string, [string, Record<string, unknown>]> = {
        'voice-render': ['voice_render', { slug: project.slug, beat: fix.params?.beat }],
        'make-timeline': ['take_generate', { slug: project.slug, take: take ?? 'episode' }],
        parts: ['parts_resolve', { slug: project.slug }],
        'world-clip': ['clip_run', { slug: project.slug }],
        'mk-build-take': ['take_generate', { slug: project.slug, take }],
        'mk-flow-take': ['take_generate', { slug: project.slug, take }],
        'join-takes': ['take_generate', { slug: project.slug, take }],
      };
      const chosen = map[fix.command];
      if (!chosen) return say(`no button for ${fix.command} yet`, 'bad');
      await op(chosen[0], chosen[1]);
      say(`${fix.command} done`, 'good');
      await load();
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setRunning(null);
    }
  };

  return (
    <>
      <h1>{project.name}</h1>
      <p className="lede">
        {project.stats?.blocks ?? '?'} blocks in {project.stats?.size?.join(' × ') ?? '?'} ·
        {' '}{project.takes.length} takes · needs {project.requires?.mods?.join(', ') || 'nothing but vanilla'}
      </p>

      <div className="row" style={{ gap: '0.4rem' }}>
        <span className={`pill ${status.ok ? 'good' : 'bad'}`}>{status.ok ? 'ready to shoot' : 'not ready'}</span>
        <button onClick={() => load()}>Re-check</button>
        {links.some((l: any) => l.state === 'suspect' || l.state === 'stale') && (
          <button disabled={running !== null} onClick={async () => {
            setRunning('all');
            try {
              for (const take of project.takes) {
                await op('take_generate', { slug: project.slug, take: take.name }).catch(() => {});
              }
              say('every take regenerated from its own documents', 'good');
              await load();
            } finally { setRunning(null); }
          }}>{running === 'all' ? 'regenerating…' : 'Regenerate every take'}</button>
        )}
      </div>

      <h2>Narration</h2>
      {narration ? (
        <table>
          <thead><tr><th>Beat</th><th>State</th><th>Measured</th><th>Words</th><th /></tr></thead>
          <tbody>
            {narration.beats.map((beat: any) => (
              <tr key={beat.id}>
                <td className="mono">{beat.id}</td>
                <td>
                  <span className={`pill ${beat.state === 'fresh' ? 'good' : beat.state === 'stale' ? 'warn' : ''}`}>
                    {beat.state}
                  </span>
                </td>
                <td className="mono">{beat.measuredMs ? `${(beat.measuredMs / 1000).toFixed(1)} s` : '—'}</td>
                <td className="dim">{beat.why}</td>
                <td>
                  {beat.state !== 'fresh' && (
                    <button disabled={running !== null}
                      onClick={() => repair({ command: 'voice-render', params: { beat: beat.id } }, beat.id)}>
                      Speak {beat.id}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="faint">No beats file.</p>}

      <h2>Derivations</h2>
      {stale.length === 0 ? <p className="dim">Everything follows what it is built on.</p> : (
        <table>
          <thead><tr><th>State</th><th>What</th><th /></tr></thead>
          <tbody>
            {stale.map((link: any, i: number) => (
              <tr key={i}>
                <td><span className={`pill ${link.state === 'missing' || link.state === 'stale' ? 'bad' : 'warn'}`}>{link.state}</span></td>
                <td>{link.why}</td>
                <td>
                  {link.fix && (
                    <button disabled={running !== null} onClick={() => repair(link.fix, link.why)}>
                      {running === link.why ? 'working…' : link.fix.command}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {status.findings.filter((f: any) => f.level === 'error').length > 0 && (
        <>
          <h2>Wrong, not merely stale</h2>
          <table>
            <tbody>
              {status.findings.filter((f: any) => f.level === 'error').map((finding: any, i: number) => (
                <tr key={i}><td>{finding.text}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Next</h2>
      <div className="row wrap">
        <button onClick={() => setPanel('script')}>Write the words</button>
        <button onClick={() => setPanel('timeline')}>Place them in time</button>
        <button onClick={() => setPanel('camera')}>Point the camera</button>
        <button onClick={() => setPanel('runner')}>Shoot it</button>
      </div>
    </>
  );
}
