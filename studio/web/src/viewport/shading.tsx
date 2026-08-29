/**
 * How the build is painted, as a control that floats over it.
 *
 * Four ways to look at the same thousand cubes, and none of them is the right one for every
 * question: what a machine *is* wants its texture, what an assembly *owns* wants a colour, and
 * when a block is *placed* wants a gradient. The switch sits on the viewport rather than in a
 * sidebar because it is answered by looking, and looking away to change it defeats the point.
 *
 * When the game has never been asked what its blocks look like, the switch says so and offers to
 * ask — which is a better answer than three modes that quietly all look the same.
 */

import { useState } from 'react';
import { op } from '../api';
import { useStudio } from '../store';
import type { Shading } from './viewport';

const MODES: { id: Shading; label: string; why: string; needsAtlas?: boolean; needsTimes?: boolean }[] = [
  { id: 'texture', label: 'Texture', why: 'the blocks as the game draws them', needsAtlas: true },
  { id: 'part', label: 'Assembly', why: 'textures, tinted by the assembly that owns them' },
  { id: 'part-flat', label: 'Flat', why: 'assembly colours only — the clearest grouping' },
  { id: 'time', label: 'Build order', why: 'early is cool, late is warm', needsTimes: true },
];

export function ShadingSwitch({ hasTimes = false }: { hasTimes?: boolean }) {
  const { shading, setShading, atlas, project, director, say } = useStudio();
  const [busy, setBusy] = useState(false);

  const fetchAtlas = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const got = await op('block_appearance', { slug: project.slug });
      say(`${got.tiles} tiles for ${got.types} block types`, 'good');
      // openProject is what reads the caches; re-opening is cheaper than a second path to them.
      await useStudio.getState().openProject(project.slug);
      setShading('texture');
    } catch (error: any) {
      say(error.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: 'absolute', top: '0.6rem', left: '0.6rem', zIndex: 2,
      display: 'flex', gap: '0.3rem', alignItems: 'center',
      background: 'rgba(16,18,22,0.82)', border: '1px solid var(--line)',
      borderRadius: 7, padding: '0.25rem',
    }}>
      {MODES.map((mode) => {
        const off = (mode.needsAtlas && !atlas) || (mode.needsTimes && !hasTimes);
        return (
          <button key={mode.id} disabled={off} title={off
            ? (mode.needsAtlas ? 'no textures cached from the game yet' : 'no take chosen to time this against')
            : mode.why}
            onClick={() => setShading(mode.id)}
            style={{
              padding: '0.15rem 0.5rem', fontSize: 11,
              background: shading === mode.id ? '#1e3a4a' : 'transparent',
              borderColor: shading === mode.id ? '#2e6a86' : 'var(--line)',
              color: shading === mode.id ? '#cfefff' : 'var(--text-dim)',
            }}>
            {mode.label}
          </button>
        );
      })}
      {!atlas && (
        <button className="primary" disabled={busy || !director.up}
          title={director.up ? 'ask the running instance for its block textures'
            : 'the instance is closed — it is the only thing that has the textures'}
          onClick={fetchAtlas}
          style={{ padding: '0.15rem 0.5rem', fontSize: 11 }}>
          {busy ? 'asking…' : 'Get textures'}
        </button>
      )}
    </div>
  );
}
