/**
 * Projects: open one, take a snapshot of it, send it to somebody.
 *
 * The list is also the honest answer to "what is in this repository" — episodes that have all
 * their files but have never been tied together show up as adoptable rather than being invented
 * into projects behind somebody's back.
 */

import { useEffect, useState } from 'react';
import { op } from '../api';
import { useStudio } from '../store';

export function Projects() {
  const { projects, adoptable, project, openProject, refreshProjects, say, setPanel } = useStudio();
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<any>(null);

  const loadSnapshots = async (slug: string) => {
    const listed = await op('project_snapshots', { slug });
    setSnapshots(listed.snapshots);
  };

  useEffect(() => {
    if (project) loadSnapshots(project.slug).catch(() => setSnapshots([]));
  }, [project?.slug]);

  const guard = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    try {
      await work();
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h1>Projects</h1>
      <p className="lede">
        An episode is a project: prose, beats, storyboard, schematic, parts and every take that
        comes out of them. Saving happens as you work; a snapshot is what you come back to.
      </p>

      <div className="cards">
        {projects.map((entry: any) => (
          <div className="card" key={entry.slug}>
            <div className="row">
              <strong>{entry.name}</strong>
              {project?.slug === entry.slug && <span className="pill good">open</span>}
            </div>
            <div className="mono faint" style={{ marginTop: '0.2rem' }}>{entry.slug}</div>
            <div className="dim" style={{ margin: '0.5rem 0' }}>
              {entry.takes?.length ?? 0} takes · world {entry.world}
            </div>
            <div className="row wrap">
              <button className="primary" onClick={() => guard('open', async () => {
                await openProject(entry.slug);
                setPanel('dashboard');
              })}>Open</button>
              <button onClick={() => guard('export', async () => {
                const result = await op('project_export', { slug: entry.slug, profile: 'source' });
                say(`exported ${result.files} files to ${result.path}`, 'good');
              })}>Export</button>
              <button onClick={() => guard('doctor', async () => {
                setDoctor(await op('project_doctor', { slug: entry.slug }));
              })}>Check</button>
            </div>
          </div>
        ))}

        {adoptable.map((entry: any) => (
          <div className="card" key={entry.slug} style={{ borderStyle: 'dashed' }}>
            <div className="row"><strong>{entry.slug}</strong><span className="pill">not yet a project</span></div>
            <div className="dim" style={{ margin: '0.5rem 0' }}>
              Has a storyboard and everything it names, but nothing tying them together yet.
            </div>
            <button onClick={() => guard('adopt', async () => {
              await op('project_adopt', { slug: entry.slug });
              await refreshProjects();
              say(`${entry.slug} is a project now`, 'good');
            })}>Adopt</button>
          </div>
        ))}
      </div>

      {doctor && (
        <>
          <h2>Check · {doctor.slug}</h2>
          {doctor.findings.length === 0
            ? <p className="dim">Nothing to report.</p>
            : (
              <table>
                <thead><tr><th>Level</th><th>What</th><th>Fix</th></tr></thead>
                <tbody>
                  {doctor.findings.map((finding: any, i: number) => (
                    <tr key={i}>
                      <td><span className={`pill ${finding.level === 'error' ? 'bad' : 'warn'}`}>{finding.level}</span></td>
                      <td>{finding.text}</td>
                      <td className="mono faint">{finding.fix?.command ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </>
      )}

      {project && (
        <>
          <h2>Snapshots · {project.name}</h2>
          <div className="row wrap" style={{ marginBottom: '0.7rem' }}>
            <button disabled={busy !== null} onClick={() => guard('snapshot', async () => {
              const label = prompt('What is this snapshot called?', 'checkpoint');
              if (!label) return;
              await op('project_snapshot', { slug: project.slug, label });
              await loadSnapshots(project.slug);
              say('snapshot taken', 'good');
            })}>Take a snapshot</button>
            <button onClick={() => guard('save-as', async () => {
              const as = prompt('Copy this project as…', `${project.slug}-copy`);
              if (!as) return;
              await op('project_save_as', { slug: project.slug, as });
              await refreshProjects();
              say(`copied to ${as}`, 'good');
            })}>Save a copy</button>
            <button onClick={() => guard('import', async () => {
              const file = prompt('Which .ndproj?', 'out/export/…​.ndproj');
              if (!file) return;
              const result = await op('project_import', { file });
              await refreshProjects();
              say(`imported ${result.slug}: ${result.files.length} files`, 'good');
            })}>Import a .ndproj</button>
          </div>
          {snapshots.length === 0 ? <p className="faint">No snapshots yet.</p> : (
            <table>
              <thead><tr><th>Taken</th><th>Label</th><th>Why</th><th>Size</th><th /></tr></thead>
              <tbody>
                {snapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="mono">{new Date(snapshot.taken).toLocaleString()}</td>
                    <td>{snapshot.label}</td>
                    <td className="dim">{snapshot.reason}</td>
                    <td className="mono faint">{(snapshot.bytes / 1024).toFixed(0)} kB</td>
                    <td>
                      <button onClick={() => guard('restore', async () => {
                        const plan = await op('project_restore', { slug: project.slug, id: snapshot.id, dryRun: true });
                        const changed = plan.changes.filter((c: any) => c.state !== 'same');
                        if (!changed.length) return say('nothing would change');
                        if (!confirm(`Restore ${snapshot.label}?\n\n${changed.map((c: any) => `${c.state}: ${c.path}`).join('\n')}`)) return;
                        await op('project_restore', { slug: project.slug, id: snapshot.id });
                        await openProject(project.slug);
                        await loadSnapshots(project.slug);
                        say('restored', 'good');
                      })}>Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
