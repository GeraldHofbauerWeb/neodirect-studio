/**
 * Shooting it, and finding out whether it worked.
 *
 * Three things after a take, and none of them is watching the video: what drifted, whether the
 * world matches the schematic, and how far the camera strayed from the curve it was given. The
 * last one is here because it was invisible for a long time — the server was pushing the camera
 * out of the machine it was filming and suppressing the warning that would have said so.
 */

import { useEffect, useRef, useState } from 'react';
import { mediaUrl, op } from '../api';
import { useStudio } from '../store';

export function Runner() {
  const { project, take, director, jobs, say } = useStudio();
  const [capture, setCapture] = useState<'obs' | 'none' | 'framegrab'>('obs');
  const [log, setLog] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [drift, setDrift] = useState<string[] | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const tail = useRef<HTMLDivElement>(null);

  const current = job ? jobs[job] : null;
  useEffect(() => { tail.current?.scrollTo({ top: tail.current.scrollHeight }); }, [current?.lines.length]);

  const loadLog = async () => {
    if (!project || !take) return;
    try { setLog(await op('take_log', { slug: project.slug, take })); } catch { setLog(null); }
  };
  useEffect(() => { loadLog(); }, [project?.slug, take, current?.running]);

  if (!project) return null;

  const start = async () => {
    try {
      const started = await op('take_run', { slug: project.slug, take, capture });
      setJob(started.job);
      say(`recording ${take}`, 'good');
    } catch (error: any) { say(error.message, 'bad'); }
  };

  const verify = async () => {
    try {
      const result = await op('verify', { slug: project.slug, take });
      setReport(result);
      say(result.ok ? 'the world matches the schematic' : 'the world does not match', result.ok ? 'good' : 'bad');
    } catch (error: any) { say(error.message, 'bad'); }
  };

  const measureDrift = async () => {
    try {
      const result = await op('camera_drift', { timeline: project.takes.find((t) => t.name === take)?.out });
      setDrift(result.lines);
    } catch (error: any) { say(error.message, 'bad'); }
  };

  const video = log?.recording ? String(log.recording).replace(/^out\/take-/, 'out/') : null;

  return (
    <>
      <h1>Record &amp; verify</h1>
      <p className="lede">{take ?? 'no take chosen'} · {director.up ? 'instance ready' : 'the instance is not running'}</p>

      <div className="row wrap">
        <select value={capture} onChange={(event) => setCapture(event.target.value as any)}>
          <option value="obs">OBS</option>
          <option value="framegrab">framebuffer only (no capture stack, ~19 fps)</option>
          <option value="none">no recording</option>
        </select>
        <button className="primary" disabled={!director.up || director.running} onClick={start}>Record</button>
        <button disabled={!director.up} onClick={verify}>Verify</button>
        <button disabled={!director.up || director.running} onClick={measureDrift}>Measure camera drift</button>
        <button onClick={loadLog}>Reload log</button>
      </div>

      {current && (
        <>
          <h2>{current.label} {current.running ? '· running' : `· exit ${current.exitCode}`}</h2>
          <div className="log" ref={tail}>{current.lines.join('\n')}</div>
        </>
      )}

      {log?.present !== false && log && (
        <>
          <h2>What the take did</h2>
          <div className="row">
            <span className="mono dim">
              planned {(log.plannedDurationMs / 1000).toFixed(1)} s · actual {(log.actualDurationMs / 1000).toFixed(1)} s
              {log.recordLeadMs ? ` · recorder led by ${log.recordLeadMs} ms` : ''}
            </span>
            <span className={`pill ${log.drifted?.length ? 'warn' : 'good'}`}>
              {log.drifted?.length ?? 0} cues off by more than 250 ms
            </span>
          </div>
          <table style={{ marginTop: '0.5rem' }}>
            <thead><tr><th>Cue</th><th>Planned</th><th>Actual</th><th>Drift</th><th>Detail</th></tr></thead>
            <tbody>
              {log.events.slice(0, 60).map((event: any, i: number) => {
                const delta = (event.actualMs ?? 0) - (event.plannedMs ?? 0);
                return (
                  <tr key={i}>
                    <td className="mono">{event.kind}</td>
                    <td className="mono">{event.plannedMs}</td>
                    <td className="mono">{event.actualMs}</td>
                    <td className="mono" style={{ color: Math.abs(delta) > 250 ? 'var(--warn)' : undefined }}>
                      {delta >= 0 ? '+' : ''}{delta}
                    </td>
                    <td className="dim">{String(event.detail ?? '').slice(0, 90)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {drift && <><h2>Camera drift</h2><div className="log">{drift.join('\n')}</div></>}

      {report && (
        <>
          <h2>Verify</h2>
          <div className="row wrap">
            <span className={`pill ${report.ok ? 'good' : 'bad'}`}>{report.ok ? 'matches' : 'does not match'}</span>
            <span className="mono dim">{report.matched}/{report.blocksInSchematic} blocks</span>
            {report.missing > 0 && <span className="pill bad">{report.missing} missing</span>}
            {report.wrongState > 0 && <span className="pill bad">{report.wrongState} wrong state</span>}
            {report.looseItems > 0 && <span className="pill warn">{report.looseItems} loose items</span>}
            <span className={`pill ${report.cameraClearance?.length ? 'bad' : 'good'}`}>
              {report.cameraClearance?.length ? `${report.cameraClearance.length} shots clip` : 'camera paths clear'}
            </span>
          </div>
          {report.mismatches?.length > 0 && (
            <table style={{ marginTop: '0.5rem' }}>
              <thead><tr><th>Where</th><th>Expected</th><th>Found</th></tr></thead>
              <tbody>
                {report.mismatches.map((mismatch: any, i: number) => (
                  <tr key={i}>
                    <td className="mono">{mismatch.pos}</td>
                    <td className="mono">{mismatch.expected}</td>
                    <td className="mono">{mismatch.actual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {video && (
        <>
          <h2>The take</h2>
          <video controls style={{ width: '100%', maxWidth: '52rem', borderRadius: 8, border: '1px solid var(--line)' }}
            src={mediaUrl(video)} />
        </>
      )}
    </>
  );
}
