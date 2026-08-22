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

export type ViewportProps = {
  blocks: Block[];
  colors: Record<string, string>;
  parts?: Record<string, number[]>;
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

  useEffect(() => { scene.current?.setBlocks(props); }, [props.blocks, props.colors, props.colourBy, props.parts]);
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

  setBlocks({ blocks, colors, parts, colourBy }: ViewportProps) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    if (!blocks.length) return;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // Not `vertexColors`: that asks the shader for a per-vertex colour attribute a box geometry
    // does not carry, and what comes back is black with no complaint. Per-instance colours are a
    // separate mechanism and need no flag — setColorAt is enough.
    const material = new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, blocks.length);
    const matrix = new THREE.Matrix4();
    const partOf = new Map<number, number>();
    if (parts) {
      Object.values(parts).forEach((indices, n) => indices.forEach((i) => partOf.set(i, n)));
    }

    this.indexFor = [];
    this.baseColour = [];
    const centre = new THREE.Vector3();
    blocks.forEach((block, n) => {
      matrix.setPosition(block.pos[0] + 0.5, block.pos[1] + 0.5, block.pos[2] + 0.5);
      mesh.setMatrixAt(n, matrix);
      const colour = new THREE.Color(colourBy === 'part' && partOf.has(block.i)
        ? PART_COLOURS[partOf.get(block.i)! % PART_COLOURS.length]
        : colourOf(block.id, colors));
      mesh.setColorAt(n, colour);
      this.baseColour[n] = colour;
      this.indexFor[n] = block.i;
      centre.add(new THREE.Vector3(...block.pos));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
    this.scene.add(mesh);

    centre.divideScalar(blocks.length);
    this.controls.target.copy(centre);
    const spread = Math.max(...blocks.map((b) => Math.hypot(b.pos[0] - centre.x, b.pos[2] - centre.z))) || 20;
    this.camera.position.set(centre.x + spread * 1.6, centre.y + spread * 1.1, centre.z + spread * 1.6);
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
      else if (faded.has(index)) colour = this.baseColour[n].clone().multiplyScalar(0.22);
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
