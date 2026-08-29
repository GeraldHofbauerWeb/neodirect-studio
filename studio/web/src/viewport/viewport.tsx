/**
 * The build, in three dimensions.
 *
 * What this is for is the two questions a list of coordinates cannot answer: which blocks a cue
 * is actually about, and whether a shot can see them. So it draws the schematic as voxels in the
 * colours Minecraft would paint them, the parts in their own colours when asked, the camera path
 * as the curve the game will fly, and the camera's body as the box the verifier measures rather
 * than as a point.
 *
 * A thousand blocks is nothing for one instanced mesh, so there is no level of detail here and no
 * culling beyond what three does itself. Keyframe markers are thinned, because a follow take has
 * four hundred of them and a string of beads is not a diagram.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Keyframe } from '../lib/cameraPath';
import { samplePath, CAMERA_BOX } from '../lib/cameraPath';
import { colourOf, PART_COLOURS, type Block } from '../store';

/** What the game said its blocks look like, cached by `block_appearance`. */
export type Atlas = {
  tile: number;
  columns: number;
  rows: number;
  blocks: Record<string, { top: number; side: number; bottom: number }>;
  atlas: string;
};

/**
 * How the cubes are painted.
 *
 * Texture and grouping are not a choice between two pictures — a machine you cannot recognise and
 * a grouping you cannot see are both useless — so `part` keeps both: the real faces, tinted in the
 * colour of the assembly that owns them.
 */
export type Shading = 'texture' | 'part' | 'part-flat' | 'time';

export type ViewportProps = {
  blocks: Block[];
  colors: Record<string, string>;
  parts?: Record<string, number[]>;
  atlas?: Atlas | null;
  shading?: Shading;
  /** When each block is placed, by block index — what `time` shades by. */
  times?: Record<number, number> | null;
  colourBy?: 'block' | 'part';
  selection?: number[];
  ghost?: number[];
  path?: { keyframes: Keyframe[]; ease?: 'inOut' | 'linear'; blocked?: boolean[] } | null;
  standpoints?: { pos: [number, number, number]; cut?: boolean; blind?: boolean }[];
  water?: [number, number, number][];
  origin?: [number, number, number];
  onPick?: (index: number | null) => void;
};

export function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene3D | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const view = new Scene3D(host.current, props.onPick);
    scene.current = view;
    return () => view.dispose();
  }, []);

  useEffect(() => { scene.current?.setBlocks(props); },
    [props.blocks, props.colors, props.colourBy, props.parts, props.atlas, props.shading, props.times]);
  useEffect(() => { scene.current?.setHighlight(props.selection ?? [], props.ghost ?? []); }, [props.selection, props.ghost]);
  useEffect(() => { scene.current?.setPath(props.path ?? null); }, [props.path]);
  useEffect(() => { scene.current?.setStandpoints(props.standpoints ?? []); }, [props.standpoints]);
  useEffect(() => { scene.current?.setWater(props.water ?? [], props.origin ?? [0, 0, 0]); }, [props.water]);

  return <div ref={host} style={{ position: 'absolute', inset: 0, background: '#0e1014' }} />;
}

/** Everything three.js, kept out of React so a re-render is not a rebuild of the scene. */
class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private mesh: THREE.InstancedMesh | null = null;
  private indexFor: number[] = [];
  private baseColour: THREE.Color[] = [];
  private line: THREE.Line | null = null;
  private markers: THREE.Group = new THREE.Group();
  private waterMesh: THREE.InstancedMesh | null = null;
  private atlasCache: { source: string; texture: THREE.Texture } | null = null;
  private frame = 0;
  private raycaster = new THREE.Raycaster();

  constructor(private host: HTMLElement, private onPick?: (index: number | null) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    this.camera.position.set(28, 22, 28);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.background = new THREE.Color('#0e1014');
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 0.6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-1, 0.4, -0.8);
    this.scene.add(fill);
    this.scene.add(this.markers);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.domElement.addEventListener('pointerdown', (event) => this.pick(event));
    this.tick();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tick = () => {
    this.frame = requestAnimationFrame(this.tick);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  setBlocks({ blocks, colors, parts, colourBy, atlas, shading, times }: ViewportProps) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    if (!blocks.length) return;

    // `colourBy` came first and said only block-or-part; `shading` says the same thing and two
    // more. One is derived from the other so every panel keeps working while they converge.
    const mode: Shading = shading ?? (colourBy === 'part' ? 'part' : 'texture');
    const textured = mode !== 'part-flat' && !!atlas;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // Not `vertexColors`: that asks the shader for a per-vertex colour attribute a box geometry
    // does not carry, and what comes back is black with no complaint. Per-instance colours are a
    // separate mechanism and need no flag — setColorAt is enough.
    const material = textured ? this.atlasMaterial(atlas!) : new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, blocks.length);
    const matrix = new THREE.Matrix4();
    const partOf = new Map<number, number>();
    if (parts) {
      Object.values(parts).forEach((indices, n) => indices.forEach((i) => partOf.set(i, n)));
    }

    // The tile each face samples, per instance. −1 means "this block is not in the atlas" — the
    // shader then leaves the instance colour alone, so a block the game did not know still lands
    // in its map colour instead of in whatever tile zero happens to be.
    const tiles = new Float32Array(blocks.length * 3);
    const shadeByTime = timeSpread(blocks, times);

    this.indexFor = [];
    this.baseColour = [];
    const centre = new THREE.Vector3();
    const white = new THREE.Color('#ffffff');
    blocks.forEach((block, n) => {
      matrix.setPosition(block.pos[0] + 0.5, block.pos[1] + 0.5, block.pos[2] + 0.5);
      mesh.setMatrixAt(n, matrix);

      const faces = atlas?.blocks[block.id];
      tiles.set(faces ? [faces.top, faces.side, faces.bottom] : [-1, -1, -1], n * 3);

      const part = partOf.has(block.i)
        ? new THREE.Color(PART_COLOURS[partOf.get(block.i)! % PART_COLOURS.length])
        : null;
      const flat = new THREE.Color(colourOf(block.id, colors));
      let colour: THREE.Color;
      if (mode === 'part-flat') colour = part ?? flat;
      else if (mode === 'time') colour = shadeByTime(block.i);
      else if (mode === 'part' && part) {
        // Lightened before it multiplies: a tint over a texture darkens, and an assembly colour
        // applied at full strength turns a machine into a silhouette of itself.
        colour = textured && faces ? part.clone().lerp(white, 0.45) : part;
      } else colour = textured && faces ? white.clone() : flat;

      mesh.setColorAt(n, colour);
      this.baseColour[n] = colour;
      this.indexFor[n] = block.i;
      centre.add(new THREE.Vector3(...block.pos));
    });
    geometry.setAttribute('tile', new THREE.InstancedBufferAttribute(tiles, 3));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
    this.scene.add(mesh);

    centre.divideScalar(blocks.length);
    this.controls.target.copy(centre);
    const spread = Math.max(...blocks.map((b) => Math.hypot(b.pos[0] - centre.x, b.pos[2] - centre.z))) || 20;
    this.camera.position.set(centre.x + spread * 1.6, centre.y + spread * 1.1, centre.z + spread * 1.6);
  }

  /**
   * A Lambert material that reads its colour out of the packed atlas.
   *
   * Three tiles per instance and one draw call for the whole build: the face is chosen in the
   * shader from the cube's own normal rather than by splitting the mesh per material, because a
   * thousand blocks in six materials is six thousand draws and a thousand blocks in one is one.
   *
   * The instance colour still multiplies over the sample, which is what makes `part` shading a
   * tint rather than a replacement — and what lets a selection glow without a second mesh.
   */
  private atlasMaterial(atlas: Atlas) {
    const material = new THREE.MeshLambertMaterial({ map: this.atlasTexture(atlas) });
    // Cutouts — panes, ladders, anything with holes in its texture — rather than blending, which
    // would need sorting for a thousand cubes and buy nothing on a diagram.
    material.alphaTest = 0.35;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.atlasGrid = { value: new THREE.Vector2(atlas.columns, atlas.rows) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 tile;
          varying vec3 vTile;
          varying vec3 vFace;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vTile = tile;
          vFace = normal;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vTile;
          varying vec3 vFace;
          uniform vec2 atlasGrid;`)
        .replace('#include <map_fragment>', `
          float tileIndex = vFace.y > 0.5 ? vTile.x : (vFace.y < -0.5 ? vTile.z : vTile.y);
          if (tileIndex >= 0.0) {
            vec2 cell = vec2(mod(tileIndex, atlasGrid.x), floor(tileIndex / atlasGrid.x));
            // Pulled a hair inside the tile: sampling exactly on the seam picks up the neighbour,
            // and one bright pixel along every cube edge reads as a grid drawn on the build.
            vec2 within = clamp(vMapUv, 0.001, 0.999);
            diffuseColor *= texture2D(map, (cell + within) / atlasGrid);
          }`);
    };
    return material;
  }

  /** Decoded once per atlas: switching shading modes should not re-decode a PNG. */
  private atlasTexture(atlas: Atlas) {
    if (this.atlasCache?.source === atlas.atlas) return this.atlasCache.texture;
    this.atlasCache?.texture.dispose();
    const texture = new THREE.TextureLoader().load(atlas.atlas);
    // Minecraft's pixels stay pixels, and without mipmaps no neighbouring tile can bleed in.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    this.atlasCache = { source: atlas.atlas, texture };
    return texture;
  }

  /** Selected blocks glow; ghosted ones fade back, which is how "not yet placed" reads. */
  setHighlight(selection: number[], ghost: number[]) {
    if (!this.mesh) return;
    const selected = new Set(selection);
    const faded = new Set(ghost);
    const white = new THREE.Color('#ffffff');
    for (let n = 0; n < this.indexFor.length; n++) {
      const index = this.indexFor[n];
      let colour = this.baseColour[n];
      if (selected.has(index)) colour = this.baseColour[n].clone().lerp(white, 0.65);
      else if (faded.has(index)) colour = this.baseColour[n].clone().multiplyScalar(0.13);
      this.mesh.setColorAt(n, colour);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setPath(path: ViewportProps['path']) {
    if (this.line) { this.scene.remove(this.line); this.line.geometry.dispose(); this.line = null; }
    this.markers.clear();
    if (!path || path.keyframes.length < 2) return;

    const poses = samplePath(path.keyframes, path.ease ?? 'inOut', 200);
    const geometry = new THREE.BufferGeometry().setFromPoints(
      poses.map((pose) => new THREE.Vector3(...pose.pos)));
    const colours = new Float32Array(poses.length * 3);
    poses.forEach((_, i) => {
      const blocked = path.blocked?.[Math.floor((i / poses.length) * (path.blocked?.length ?? 0))];
      const colour = new THREE.Color(blocked ? '#f87171' : '#7dd3fc');
      colours.set([colour.r, colour.g, colour.b], i * 3);
    });
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.scene.add(this.line);

    // The body, not a point — drawn at the keyframes, thinned so a follow run stays legible.
    const every = Math.max(1, Math.floor(path.keyframes.length / 24));
    const box = new THREE.BoxGeometry(CAMERA_BOX.half * 2, CAMERA_BOX.below + CAMERA_BOX.above, CAMERA_BOX.half * 2);
    path.keyframes.forEach((keyframe, i) => {
      if (i % every !== 0 && i !== path.keyframes.length - 1) return;
      const marker = new THREE.Mesh(box, new THREE.MeshBasicMaterial({
        color: i === 0 ? '#86efac' : '#7dd3fc', wireframe: true,
      }));
      marker.position.set(keyframe.pos[0], keyframe.pos[1] - (CAMERA_BOX.below - CAMERA_BOX.above) / 2, keyframe.pos[2]);
      this.markers.add(marker);
      // Which way it is looking: Minecraft yaw, 0 south, 90 west, positive pitch down.
      const yaw = THREE.MathUtils.degToRad(keyframe.yaw);
      const pitch = THREE.MathUtils.degToRad(keyframe.pitch);
      const direction = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const arrow = new THREE.ArrowHelper(direction, new THREE.Vector3(...keyframe.pos), 2.2, 0x7dd3fc, 0.5, 0.28);
      this.markers.add(arrow);
    });
  }

  /** Where the follow style would stand: green normally, amber at a cut, red where nothing sees it. */
  setStandpoints(points: NonNullable<ViewportProps['standpoints']>) {
    const existing = this.scene.getObjectByName('standpoints');
    if (existing) this.scene.remove(existing);
    if (!points.length) return;
    const group = new THREE.Group();
    group.name = 'standpoints';
    const geometry = new THREE.SphereGeometry(0.22, 8, 6);
    for (const point of points) {
      const dot = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: point.blind ? '#f87171' : point.cut ? '#fbbf24' : '#86efac',
      }));
      dot.position.set(...point.pos);
      group.add(dot);
    }
    this.scene.add(group);
  }

  setWater(positions: [number, number, number][], origin: [number, number, number]) {
    if (this.waterMesh) { this.scene.remove(this.waterMesh); this.waterMesh.geometry.dispose(); this.waterMesh = null; }
    if (!positions.length) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: '#3b82f6', transparent: true, opacity: 0.16 }),
      positions.length);
    const matrix = new THREE.Matrix4();
    positions.forEach((pos, n) => {
      matrix.setPosition(pos[0] - origin[0] + 0.5, pos[1] - origin[1] + 0.5, pos[2] - origin[2] + 0.5);
      mesh.setMatrixAt(n, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.waterMesh = mesh;
    this.scene.add(mesh);
  }

  private pick(event: PointerEvent) {
    if (!this.mesh || !this.onPick || event.button !== 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh);
    this.onPick(hits.length && hits[0].instanceId !== undefined ? this.indexFor[hits[0].instanceId] : null);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/**
 * A colour per block for `time` shading: early is cool, late is warm.
 *
 * The build order is a fact about the take that is otherwise only visible by dragging the playhead
 * across the whole episode. As a gradient it is one glance — and it is the same arithmetic the
 * playhead uses, so the two cannot disagree.
 */
function timeSpread(blocks: Block[], times: Record<number, number> | null | undefined) {
  const known = blocks.map((b) => times?.[b.i]).filter((ms): ms is number => typeof ms === 'number');
  if (!known.length) return () => new THREE.Color('#4b5563');
  const first = Math.min(...known);
  const last = Math.max(...known);
  const span = Math.max(1, last - first);
  const early = new THREE.Color('#38bdf8');
  const late = new THREE.Color('#fb923c');
  return (index: number) => {
    const ms = times?.[index];
    // A block no cue places is not early — it is never, and it should not read as the beginning.
    if (typeof ms !== 'number') return new THREE.Color('#3f3f46');
    return early.clone().lerp(late, (ms - first) / span);
  };
}
