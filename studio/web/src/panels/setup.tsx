/**
 * The machinery around the episode: the instance, the recorder, the tests.
 */

import { useEffect, useState } from 'react';
import { op } from '../api';
import { useStudio } from '../store';

export function Setup() {
  const { director, project, say, jobs } = useStudio();
  const [health, setHealth] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const refresh = async () => setHealth(await op('health'));
  useEffect(() => { refresh().catch(() => {}); }, [director.up]);

  const run = async (label: string, name: string, params: Record<string, unknown> = {}) => {
    setBusy(label);
    setLog([]);
    try {
      const result: any = await op(name, params);
      setLog(result.lines ?? [String(result.job ? `started as job ${result.job}` : JSON.stringify(result))]);
      say(`${label} done`, 'good');
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setBusy(null);
      refresh().catch(() => {});
    }
  };

  const running = Object.values(jobs).filter((job) => job.running);

  return (
    <>
      <h1>Setup</h1>
      <p className="lede">The recording instance, the recorder, and the checks that keep them honest.</p>

      <h2>Instance</h2>
      <div className="card">
        <div className="row">
          <span className={`dot ${director.up ? 'good' : 'off'}`} />
          <span>{director.up ? 'up' : 'not running'}</span>
          {health?.pid && <span className="mono faint">pid {health.pid}</span>}
          {health?.eye && <span className="mono faint">camera {health.eye.map((n: number) => n.toFixed(1)).join(', ')}</span>}
          {health?.pose && <span className="mono faint">{String(health.pose).toLowerCase()}</span>}
        </div>
        <div className="row wrap" style={{ marginTop: '0.6rem' }}>
          <button disabled={busy !== null || director.up}
            onClick={() => run('runClient', 'gradle', { task: 'runClient', world: project?.world })}>
            Start the instance
          </button>
          <button disabled={busy !== null} onClick={() => run('installSchematics', 'schematic_install')}>
            Install schematics
          </button>
          <button disabled={busy !== null} onClick={() => refresh()}>Re-check</button>
        </div>
        <p className="faint" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
          The director reads schematics from the game's own folder, so an edit that is not installed
          is an edit that does not happen.
        </p>
      </div>

      <h2>Recorder</h2>
      <div className="card">
        <div className="row wrap">
          <button disabled={busy !== null} onClick={() => run('obs-setup', 'obs_setup')}>Build the OBS scene</button>
        </div>
        <p className="faint" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
          OBS has to be running under XWayland (<span className="mono">QT_QPA_PLATFORM=xcb obs</span>),
          the window is set by value rather than picked from a list, x264 is forced, and the scene
          records at 30 — at 60 a four-minute run came back with a third of its frames late.
        </p>
      </div>

      <h2>Checks</h2>
      <div className="row wrap">
        <button disabled={busy !== null} onClick={() => run('tests', 'tests_run', { which: 'all' })}>
          Studio tests
        </button>
        <button disabled={busy !== null} onClick={() => run('nbt tests', 'tests_run', { which: 'python' })}>
          NBT tests
        </button>
        {project && (
          <button disabled={busy !== null} onClick={() => run('storyboard', 'storyboard_check', { slug: project.slug })}>
            Check the storyboard
          </button>
        )}
      </div>

      {running.length > 0 && (
        <>
          <h2>Running</h2>
          {running.map((job) => (
            <div key={job.id} className="card" style={{ marginBottom: '0.5rem' }}>
              <div className="row"><span className="dot warn" /><strong>{job.label}</strong>
                <span className="mono faint">{job.id}</span></div>
              <div className="log" style={{ maxHeight: '10rem', marginTop: '0.5rem' }}>
                {job.lines.slice(-40).join('\n')}
              </div>
            </div>
          ))}
        </>
      )}

      {log.length > 0 && <><h2>Output</h2><div className="log">{log.join('\n')}</div></>}
    </>
  );
}
