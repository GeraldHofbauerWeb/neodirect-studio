/**
 * The shot list, and the takes that come out of it.
 *
 * Style is per assembly here rather than a flag on a command line, which is what it always was in
 * spirit: the housing is arced past and the machinery is followed, and saying so once in a
 * document is the difference between a decision and a habit.
 *
 * The variants below are the same episode filmed different ways. Each carries the arguments that
 * reproduce it, so a re-cut schematic is one button rather than a remembered incantation.
 */

import { useEffect, useState } from 'react';
import { op } from '../api';
import { useStudio } from '../store';

export function Shots() {
  const { project, say } = useStudio();
  const [list, setList] = useState<any>(null);
  const [compare, setCompare] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    if (!project) return;
    setList(await op('shots_read', { slug: project.slug }));
    setCompare(await op('takes_compare', { slug: project.slug }));
  };
  useEffect(() => { load().catch((error) => say(error.message, 'bad')); }, [project?.slug]);

  if (!project || !list) return <p className="dim">Reading the shot list…</p>;
  const shots = list.shots;

  const change = async (index: number, field: string, value: unknown) => {
    setBusy('edit');
    try {
      await op('shots_write', { slug: project.slug, ops: [{ op: 'set', pointer: `/shots/${index}/${field}`, value }] });
      await load();
      say('shot list changed — regenerate the take to see it', 'good');
    } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(null); }
  };

  const generate = async (take: string) => {
    setBusy(take);
    try {
      const result = await op('take_generate', { slug: project.slug, take });
      say(`${take}: ${result.bytes ? `${(result.bytes / 1024).toFixed(0)} kB` : 'written'}`, 'good');
      await load();
    } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(null); }
  };

  return (
    <>
      <h1>Shot list</h1>
      {!shots ? <p className="dim">This project has no shot list document.</p> : (
        <>
          <p className="lede">
            Default {shots.defaults?.style}, {shots.defaults?.msPerBlock} ms a block when followed,
            {' '}{Math.round((shots.defaults?.glideShare ?? 0) * 100)}% of that spent gliding.
          </p>
          <table>
            <thead><tr><th>Assembly</th><th>Style</th><th>Bearing</th><th>Lift</th><th>What</th></tr></thead>
            <tbody>
              {shots.shots.map((shot: any, index: number) => {
                const effective = shot.style
                  ?? ((shots.defaults?.except ?? []).includes(shot.part)
                    ? (shots.defaults?.style === 'follow' ? 'arc' : 'follow')
                    : shots.defaults?.style);
                return (
                  <tr key={shot.part}>
                    <td className="mono">{shot.part}</td>
                    <td>
                      <select value={shot.style ?? ''} disabled={busy !== null}
                        onChange={(event) => change(index, 'style', event.target.value || null)}>
                        <option value="">default ({effective})</option>
                        <option value="arc">arc</option>
                        <option value="follow">follow</option>
                      </select>
                    </td>
                    <td>
                      <input type="number" style={{ width: '5rem' }} defaultValue={shot.bearing}
                        onBlur={(event) => Number(event.target.value) !== shot.bearing
                          && change(index, 'bearing', Number(event.target.value))} />
                    </td>
                    <td>
                      <input type="number" style={{ width: '4rem' }} defaultValue={shot.lift}
                        onBlur={(event) => Number(event.target.value) !== shot.lift
                          && change(index, 'lift', Number(event.target.value))} />
                    </td>
                    <td className="dim">{shot.what}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <h2>Takes</h2>
      <table>
        <thead>
          <tr><th>Take</th><th>From</th><th>Cues</th><th>Keyframes</th><th>Linear</th><th>Length</th><th /></tr>
        </thead>
        <tbody>
          {compare?.takes.map((take: any) => (
            <tr key={take.name}>
              <td className="mono">{take.name}</td>
              <td className="faint mono">
                {take.generator}{take.args && Object.keys(take.args).length
                  ? ` ${Object.entries(take.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}` : ''}
              </td>
              <td>{take.cues ?? '—'}</td>
              <td>{take.keyframes ?? '—'}</td>
              <td>{take.linearCues ?? '—'}</td>
              <td className="mono">{take.durationMs ? `${(take.durationMs / 1000 / 60).toFixed(1)} min` : '—'}</td>
              <td>
                <button disabled={busy !== null} onClick={() => generate(take.name)}>
                  {busy === take.name ? 'writing…' : 'Regenerate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {list.stations && (
        <>
          <h2>Stations · the flow take</h2>
          <p className="lede">
            {list.stations.stations.length} stations, {list.stations.filters.length} filters, a
            {' '}{list.stations.load.length}-stack load. A station with a bearing is filmed from
            outside; one with an inside range is filmed from within the plant.
          </p>
          <table>
            <thead><tr><th>Station</th><th>How</th><th>Blocks</th><th>What</th></tr></thead>
            <tbody>
              {list.stations.stations.map((station: any) => (
                <tr key={station.name}>
                  <td className="mono">{station.name}</td>
                  <td>{station.inside ? `inside ${station.inside.near}–${station.inside.far}` : `bearing ${station.bearing}°`}</td>
                  <td>{station.blocks.length}</td>
                  <td className="dim">{station.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
