/**
 * Where the camera stands, and whether it can see anything from there.
 *
 * The two styles are here side by side because they answer different questions. An arc is chosen
 * by bearing and judged by how much of the assembly is visible from the end of it. A follow is not
 * chosen at all — the solver walks the blocks in the order they go down and picks a standpoint for
 * each — so what is worth showing is where it had to cut, and where nothing could see the block.
 *
 * Everything drawn is measured the way the take will be: the curve, not the keyframes, and the
 * camera's own crawl-sized box, not a point.
 */

import { useEffect, useState } from 'react';
import { op, screenshotUrl } from '../api';
import { useStudio } from '../store';
import { Viewport } from '../viewport/viewport';
import { ShadingSwitch } from '../viewport/shading';

export function Camera() {
  const { project, blocks, colors, parts, selection, select, director, say, atlas, shading } = useStudio();
  const [part, setPart] = useState<string>('');
  const [style, setStyle] = useState<'arc' | 'inside' | 'follow' | 'vantages'>('arc');
  const [bearing, setBearing] = useState(215);
  const [lift, setLift] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [shots, setShots] = useState<any>(null);
  const [water, setWater] = useState<[number, number, number][]>([]);
  const [still, setStill] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const names = Object.keys(parts);
  useEffect(() => { if (!part && names.length) setPart(names[0]); }, [names.length]);

  if (!project) return null;

  const solve = async () => {
    setBusy(true);
    setResult(null);
    setShots(null);
    try {
      if (style === 'follow') {
        const before = names.slice(0, names.indexOf(part));
        const found = await op('placement_shots', { slug: project.slug, part, alreadyPlaced: before });
        setShots(found);
        select(parts[part] ?? []);
        say(`${found.blocks} blocks · ${found.cuts} cuts · ${found.blind.length} blind`, found.blind.length ? 'bad' : 'good');
      } else {
        const found = await op('camera_solve', { slug: project.slug, part, style, bearing, lift, search: false });
        setResult(found);
        select(parts[part] ?? []);
        say(`visible ${Math.round((found.visibility ?? 0) * 100)}%${found.clear === false ? ' · the curve clips' : ''}`,
          found.clear === false ? 'bad' : 'good');
      }
    } catch (error: any) {
      say(error.message, 'bad');
    } finally { setBusy(false); }
  };

  const searchBearing = async () => {
    setBusy(true);
    try {
      const found = await op('camera_solve', { slug: project.slug, part, style: 'arc', bearing, lift, search: true });
      setResult(found);
      setBearing(found.bearing);
      setLift(found.lift);
      say(found.searched?.asked >= 0.45
        ? 'the bearing you asked for is fine'
        : `moved to ${found.bearing}° — it was buried from ${Math.round(found.searched.asked * 100)}%`, 'good');
    } catch (error: any) { say(error.message, 'bad'); } finally { setBusy(false); }
  };

  const keyframes = result?.keyframes ?? (shots ? shots.shots.map((shot: any) => ({
    pos: shot.pos, yaw: shot.aim.yaw, pitch: shot.aim.pitch,
  })) : null);

  const look = async (index = 0) => {
    if (!keyframes?.length) return;
    const frame = keyframes[Math.min(index, keyframes.length - 1)];
    try {
      await op('camera_set', { pos: frame.pos, yaw: frame.yaw, pitch: frame.pitch });
      setTimeout(() => setStill(screenshotUrl()), 350);
    } catch (error: any) { say(error.message, 'bad'); }
  };

  const takePose = async () => {
    try {
      const pose = await op('pose_get');
      say(`camera at ${pose.eye.map((n: number) => n.toFixed(1)).join(', ')} · yaw ${pose.yaw.toFixed(1)} pitch ${pose.pitch.toFixed(1)}`, 'good');
      setResult({
        part, style: 'stance',
        keyframes: [{ pos: pose.eye, yaw: pose.yaw, pitch: pose.pitch },
          { pos: pose.eye, yaw: pose.yaw, pitch: pose.pitch }],
      });
    } catch (error: any) { say(error.message, 'bad'); }
  };

  return (
    <div className="split" style={{ height: '100%' }}>
      <div style={{ position: 'relative', minHeight: 0 }}>
        <ShadingSwitch />
        <Viewport
          blocks={blocks} colors={colors} parts={parts} atlas={atlas} shading={shading}
          selection={selection}
          origin={project.origin}
          water={water}
          path={keyframes ? { keyframes, ease: shots ? 'linear' : 'inOut' } : null}
          standpoints={shots ? shots.shots.map((shot: any) => ({ pos: shot.pos, cut: shot.cut, blind: shot.blind })) : []}
          onPick={(index) => index !== null && select([index])}
        />
        {still && (
          <img src={still} alt="what the game sees"
            style={{ position: 'absolute', right: 12, bottom: 12, width: '38%', border: '1px solid var(--line-bright)', borderRadius: 6 }} />
        )}
      </div>

      <div className="side">
        <h2 style={{ marginTop: 0 }}>Shot</h2>
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          <div className="faint" style={{ fontSize: 11 }}>assembly</div>
          <select style={{ width: '100%' }} value={part} onChange={(event) => setPart(event.target.value)}>
            {names.map((name) => <option key={name} value={name}>{name} ({parts[name].length})</option>)}
          </select>
        </label>
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          <div className="faint" style={{ fontSize: 11 }}>style</div>
          <select style={{ width: '100%' }} value={style} onChange={(event) => setStyle(event.target.value as any)}>
            <option value="arc">arc — swing past it</option>
            <option value="follow">follow — block by block</option>
            <option value="inside">inside — stand in it</option>
            <option value="vantages">vantages — where can it be seen from</option>
          </select>
        </label>
        {style === 'arc' && (
          <div className="row" style={{ marginBottom: '0.5rem' }}>
            <label style={{ flex: 1 }}>
              <div className="faint" style={{ fontSize: 11 }}>bearing</div>
              <input style={{ width: '100%' }} type="number" value={bearing} onChange={(e) => setBearing(Number(e.target.value))} />
            </label>
            <label style={{ flex: 1 }}>
              <div className="faint" style={{ fontSize: 11 }}>lift</div>
              <input style={{ width: '100%' }} type="number" value={lift} onChange={(e) => setLift(Number(e.target.value))} />
            </label>
          </div>
        )}
        <div className="row wrap">
          <button className="primary" disabled={busy || !part} onClick={solve}>Solve</button>
          {style === 'arc' && <button disabled={busy} onClick={searchBearing}>Find a bearing</button>}
          <button disabled={!director.up} onClick={() => look(keyframes ? keyframes.length - 1 : 0)}>Look through it</button>
          <button disabled={!director.up} onClick={takePose}>Take my stance</button>
          <button onClick={async () => {
            const found = await op('water_reach', { slug: project.slug });
            setWater(found.positions);
            say(`${found.count} blocks of water reach`, 'good');
          }}>Show the water</button>
        </div>

        {result && (
          <>
            <h2>Result</h2>
            <table>
              <tbody>
                <tr><td className="faint">style</td><td>{result.style}</td></tr>
                {result.bearing !== undefined && <tr><td className="faint">bearing</td><td>{result.bearing}°</td></tr>}
                {result.visibility !== undefined && (
                  <tr><td className="faint">visible</td><td>{Math.round(result.visibility * 100)}%</td></tr>)}
                {result.clear !== undefined && (
                  <tr><td className="faint">curve</td>
                    <td><span className={`pill ${result.clear ? 'good' : 'bad'}`}>{result.clear ? 'clear' : 'clips'}</span></td></tr>)}
                {result.keyframes && <tr><td className="faint">keyframes</td><td>{result.keyframes.length}</td></tr>}
              </tbody>
            </table>
            {result.keyframes && (
              <div className="log" style={{ marginTop: '0.5rem', maxHeight: '11rem' }}>
                {JSON.stringify({ _what: part, keyframes: result.keyframes }, null, 2)}
              </div>
            )}
            {result.vantages && (
              <table style={{ marginTop: '0.5rem' }}>
                <thead><tr><th>Position</th><th>Seen</th><th>Away</th></tr></thead>
                <tbody>
                  {result.vantages.slice(0, 12).map((vantage: any, i: number) => (
                    <tr key={i} className="clickable" onClick={() => op('camera_set', { pos: vantage.pos, yaw: 0, pitch: 20 })}>
                      <td className="mono">{vantage.pos.map((n: number) => n.toFixed(1)).join(', ')}</td>
                      <td>{Math.round(vantage.seen * 100)}%</td>
                      <td>{vantage.distance.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {shots && (
          <>
            <h2>Block by block</h2>
            <div className="row" style={{ marginBottom: '0.4rem' }}>
              <span className="pill">{shots.blocks} blocks</span>
              <span className={`pill ${shots.cuts ? 'warn' : 'good'}`}>{shots.cuts} cuts</span>
              <span className={`pill ${shots.blind.length ? 'bad' : 'good'}`}>{shots.blind.length} blind</span>
            </div>
            <p className="faint" style={{ fontSize: 11 }}>
              A cut is where the camera cannot glide there calmly. Blind is where nothing can see the
              block at all — which used to be visible only in the finished video.
            </p>
            <table>
              <thead><tr><th>#</th><th>Stands</th><th>Yaw</th><th /></tr></thead>
              <tbody>
                {shots.shots.map((shot: any) => (
                  <tr key={shot.index} className="clickable" onClick={() => look(shot.index)}>
                    <td className="mono">{shot.index}</td>
                    <td className="mono">{shot.pos.join(', ')}</td>
                    <td className="mono">{shot.aim.yaw}</td>
                    <td>
                      {shot.blind && <span className="pill bad">blind</span>}
                      {shot.cut && <span className="pill warn">cut</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
