/**
 * Proposes a camera move for each part of a schematic, out of where that part actually is.
 *
 *   node tools/frame-parts.mjs schematics/ore_plant.groups.json 0,-61,0
 *
 * Framing by hand means reading a bounding box out of a report, doing the trigonometry in your
 * head and being wrong by ten blocks, which you find out one take later. The bounds are already
 * written down; this reads them and puts the camera at a distance the part's own size asks for.
 *
 * What comes out is a starting point, not a finished shot. Nothing here knows what is worth
 * looking at — only where the blocks are — so the numbers get pasted into a storyboard and then
 * argued with using tools/preview.mjs.
 */

import { readFile } from 'node:fs/promises';
import { aim } from './aim.mjs';

export function bounds(positions) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  }
  return { lo, hi, size: hi.map((h, i) => h - lo[i] + 1) };
}

/**
 * A three-quarter move that ends closer than it starts.
 *
 * Distance comes from the part's largest horizontal dimension: a six-block funnel row wants the
 * camera near enough to read a filter, and the boiler wants it far enough back to see all five
 * columns, and those are the same rule with a different number in it.
 */
export function moveFor(lo, size, origin, bearing = 215) {
  const centre = [
    origin[0] + lo[0] + size[0] / 2,
    origin[1] + lo[1] + size[1] / 2,
    origin[2] + lo[2] + size[2] / 2,
  ];
  const reach = Math.max(size[0], size[2]);
  const near = Math.max(6, reach * 0.9);
  const far = Math.max(10, reach * 1.6);

  return [far, (far + near) / 2, near].map((d, i) => {
    // Drift the bearing across the move so it is a slow arc rather than a push straight in.
    const angle = ((bearing + i * 14) * Math.PI) / 180;
    const height = centre[1] + Math.max(3, size[1] * 0.7);
    const pos = [
      round(centre[0] + d * Math.sin(angle)),
      round(height),
      round(centre[2] + d * Math.cos(angle)),
    ];
    const { yaw, pitch } = aim(pos, centre);
    return { pos, yaw, pitch };
  });
}

const round = (n) => Math.round(n * 10) / 10;

// Importable as a library — a storyboard generator wants `bounds` and `moveFor`, not the report.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [groupsPath, originArg] = process.argv.slice(2);
  if (!groupsPath) throw new Error('usage: node tools/frame-parts.mjs <groups.json> [originX,Y,Z]');
  const origin = (originArg ?? '0,0,0').split(',').map(Number);
  const groups = JSON.parse(await readFile(groupsPath, 'utf8'));

  for (const [name, positions] of Object.entries(groups.parts)) {
    const { lo, size } = bounds(positions);
    console.log(`\n// ${name}: ${positions.length} blocks, ${size.join('x')} at ${lo.join(',')}`);
    console.log(JSON.stringify({ _what: name, keyframes: moveFor(lo, size, origin) }, null, 2));
  }
}
