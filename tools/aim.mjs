/**
 * Turns "camera here, looking at there" into the yaw/pitch a keyframe needs.
 *
 *   node tools/aim.mjs 15.5,-54,5  7.5,-56.5,5
 *
 * Minecraft's yaw runs 0 = south (+Z), 90 = west (-X), 180 = north (-Z), 270 = east (+X), and
 * positive pitch looks down. Getting either sign backwards points the camera at empty sky, which
 * is a slow thing to discover by recording a take.
 */

export function aim([cx, cy, cz], [tx, ty, tz]) {
  const dx = tx - cx;
  const dy = ty - cy;
  const dz = tz - cz;
  const yaw = -Math.atan2(dx, dz) * (180 / Math.PI);
  const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * (180 / Math.PI);
  return {
    yaw: Math.round(yaw * 10) / 10,
    pitch: Math.round(pitch * 10) / 10,
    distance: Math.round(Math.hypot(dx, dy, dz) * 100) / 100,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    throw new Error('usage: node tools/aim.mjs <camX,camY,camZ> [more camera positions...] <targetX,targetY,targetZ>');
  }
  const target = args[args.length - 1].split(',').map(Number);
  for (const spec of args.slice(0, -1)) {
    const pos = spec.split(',').map(Number);
    const { yaw, pitch, distance } = aim(pos, target);
    console.log(`{ "pos": [${pos.join(', ')}], "yaw": ${yaw}, "pitch": ${pitch} },   // ${distance} blocks`);
  }
}
