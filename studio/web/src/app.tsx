/**
 * The shell: what is always on screen.
 *
 * A transport across the top, because two things are true at every moment and both change under
 * you — whether the game is there, and whether a take is running. And a rail down the side in the
 * order the work happens: pick a project, see what is stale, write the words, place them in time,
 * point the camera, decide what is built, shoot it.
 */

import { useEffect, type ReactNode } from 'react';
import { useStudio } from './store';
import { op } from './api';

import { Projects } from './panels/projects';
import { Dashboard } from './panels/dashboard';
import { Script } from './panels/script';
import { Timeline } from './panels/timeline';
import { Camera } from './panels/camera';
import { Parts } from './panels/parts';
import { Shots } from './panels/shots';
import { SchematicPanel } from './panels/schematic';
import { Runner } from './panels/runner';
import { Setup } from './panels/setup';

const PANELS: { id: string; label: string; group?: string; component: () => ReactNode; needsProject?: boolean }[] = [
  { id: 'projects', label: 'Projects', group: 'Studio', component: Projects },
  { id: 'dashboard', label: 'Dashboard', component: Dashboard, needsProject: true },
  { id: 'script', label: 'Text & voice', group: 'Episode', component: Script, needsProject: true },
  { id: 'timeline', label: 'Timeline', component: Timeline, needsProject: true },
  { id: 'camera', label: 'Camera', component: Camera, needsProject: true },
  { id: 'parts', label: 'Parts', group: 'Build', component: Parts, needsProject: true },
  { id: 'shots', label: 'Shot list', component: Shots, needsProject: true },
  { id: 'schematic', label: 'Schematic', component: SchematicPanel, needsProject: true },
  { id: 'runner', label: 'Record & verify', group: 'Take', component: Runner, needsProject: true },
  { id: 'setup', label: 'Setup', component: Setup },
];

export function App() {
  const { panel, setPanel, project, director, connect, refreshProjects, toast, say } = useStudio();

  useEffect(() => {
    const stop = connect();
    refreshProjects().catch((error) => say(error.message, 'bad'));
    return stop;
  }, []);

  const current = PANELS.find((p) => p.id === panel) ?? PANELS[0];
  const Panel = (current.needsProject && !project ? NoProject : current.component) as () => ReactNode;

  return (
    <div className="shell">
      <Transport />
      <div className="body">
        <nav className="rail">
          {PANELS.map((entry) => (
            <div key={entry.id}>
              {entry.group && <div className="group">{entry.group}</div>}
              <button
                aria-current={entry.id === panel}
                disabled={entry.needsProject && !project}
                onClick={() => setPanel(entry.id)}
                style={{ width: '100%' }}
              >
                {entry.label}
              </button>
            </div>
          ))}
          <div className="group">Instance</div>
          <div className="row mono faint" style={{ padding: '0 0.6rem' }}>
            <span className={`dot ${director.up ? 'good' : 'off'}`} />
            {director.up ? (director.running ? 'filming' : 'ready') : 'closed'}
          </div>
        </nav>
        <div className={`panel ${['timeline', 'camera', 'parts'].includes(current.id) ? 'flush' : ''}`}>
          <Panel />
        </div>
      </div>
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

function NoProject() {
  const setPanel = useStudio((s) => s.setPanel);
  return (
    <div className="empty">
      No project open. <button onClick={() => setPanel('projects')}>Pick one</button>
    </div>
  );
}

/**
 * The transport.
 *
 * Deliberately more than a status light: while a take is running the only useful thing on screen
 * is the ability to stop it, and while one is not, the useful thing is knowing where the camera
 * is — which is what tells you whether the last scrub actually moved it.
 */
function Transport() {
  const { project, director, take, setTake, say } = useStudio();

  const stop = async () => {
    try {
      await op('take_abort');
      say('take stopped', 'good');
    } catch (error: any) {
      say(error.message, 'bad');
    }
  };

  return (
    <header className="transport">
      <span className="name">NeoDirect</span>
      <span className="faint">·</span>
      <span className="dim">{project ? project.name : 'no project'}</span>
      {project && project.takes.length > 0 && (
        <select value={take ?? ''} onChange={(event) => setTake(event.target.value)}>
          {project.takes.map((entry) => (
            <option key={entry.name} value={entry.name}>{entry.name}</option>
          ))}
        </select>
      )}
      <span className="spacer" />
      {director.up && director.eye && (
        <span className="mono faint">
          camera {director.eye.map((n: number) => n.toFixed(1)).join(', ')}
          {director.pose ? ` · ${director.pose.toLowerCase()}` : ''}
        </span>
      )}
      <span className="row mono">
        <span className={`dot ${director.up ? (director.running ? 'warn' : 'good') : 'off'}`} />
        {director.up ? (director.running ? 'take running' : 'instance ready') : 'instance closed'}
      </span>
      {director.running && <button className="danger" onClick={stop}>Stop</button>}
    </header>
  );
}
