/**
 * What the studio is currently looking at.
 *
 * Deliberately thin: the documents live on disk and the server owns them, so nothing here is a
 * second copy of the truth. What is kept is the things a file cannot answer — which project is
 * open, which cue is selected, where the scrubber is, and whether the game is there.
 */

import { create } from 'zustand';
import { listen, op } from './api';

export type Project = {
  slug: string;
  name: string;
  world: string;
  origin: [number, number, number];
  manifest: string;
  documents: Record<string, string>;
  derived: Record<string, string>;
  takes: { name: string; generator: string; args?: Record<string, unknown>; out: string }[];
  requires?: { mods: string[] };
  stats?: { blocks: number; size: [number, number, number] };
};

export type Block = { i: number; pos: [number, number, number]; id: string; properties?: Record<string, string> };

export type DirectorState = { up: boolean; running?: boolean; eye?: number[]; pose?: string; reason?: string };

export type JobLine = { id: string; label: string; lines: string[]; running: boolean; exitCode: number | null };

type Store = {
  project: Project | null;
  projects: { slug: string; name: string }[];
  adoptable: { slug: string }[];
  blocks: Block[];
  parts: Record<string, number[]>;
  colors: Record<string, string>;
  director: DirectorState;
  jobs: Record<string, JobLine>;
  selection: number[];
  hovered: number | null;
  scrubMs: number;
  take: string | null;
  panel: string;
  toast: { text: string; kind: 'good' | 'bad' | 'plain' } | null;

  setPanel: (panel: string) => void;
  say: (text: string, kind?: 'good' | 'bad' | 'plain') => void;
  openProject: (slug: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  select: (indices: number[]) => void;
  hover: (index: number | null) => void;
  setScrub: (ms: number) => void;
  setTake: (take: string) => void;
  connect: () => () => void;
};

export const useStudio = create<Store>((set, get) => ({
  project: null,
  projects: [],
  adoptable: [],
  blocks: [],
  parts: {},
  colors: {},
  director: { up: false },
  jobs: {},
  selection: [],
  hovered: null,
  scrubMs: 0,
  take: null,
  panel: 'projects',
  toast: null,

  setPanel: (panel) => set({ panel }),

  say: (text, kind = 'plain') => {
    set({ toast: { text, kind } });
    setTimeout(() => set((state) => (state.toast?.text === text ? { toast: null } : {})), 6000);
  },

  async refreshProjects() {
    const listed = await op('project_list');
    set({ projects: listed.projects, adoptable: listed.adoptable });
  },

  async openProject(slug) {
    const project = await op<Project>('project_open', { slug });
    set({ project, take: project.takes[0]?.name ?? null, selection: [], scrubMs: 0 });
    if (project.derived?.schematic) {
      const loaded = await op('schematic_blocks', { slug });
      set({ blocks: loaded.blockList ?? [] });
    }
    if (project.derived?.groups) {
      const parts = await op('parts_read', { slug });
      // parts_read reports counts; the indices come from resolving each name.
      const names = Object.keys(parts.resolved?.counts ?? {});
      const resolved: Record<string, number[]> = {};
      await Promise.all(names.map(async (name) => {
        const found = await op('selector_resolve', { slug, blocks: { part: name } });
        resolved[name] = found.indices;
      }));
      set({ parts: resolved });
    }
    // Colours are a nicety: without the game the viewport falls back to its own palette.
    op('doc_read', { path: 'studio/blockcolors.json' })
      .then((doc) => set({ colors: doc.value ?? {} }))
      .catch(() => {});
  },

  select: (selection) => set({ selection }),
  hover: (hovered) => set({ hovered }),
  setScrub: (scrubMs) => set({ scrubMs }),
  setTake: (take) => set({ take }),

  connect() {
    return listen({
      director: (state) => set({ director: state }),
      start: ({ id, label }) => set((s) => ({ jobs: { ...s.jobs, [id]: { id, label, lines: [], running: true, exitCode: null } } })),
      line: ({ id, line }) => set((s) => {
        const job = s.jobs[id] ?? { id, label: id, lines: [], running: true, exitCode: null };
        return { jobs: { ...s.jobs, [id]: { ...job, lines: [...job.lines, line].slice(-500) } } };
      }),
      end: ({ id, exitCode }) => set((s) => {
        const job = s.jobs[id];
        if (!job) return {};
        return { jobs: { ...s.jobs, [id]: { ...job, running: false, exitCode } } };
      }),
    });
  },
}));

/**
 * The colour a block is drawn in.
 *
 * Minecraft's own map colours when the game has been asked for them, and a stable colour derived
 * from the block's name when it has not — the studio has to draw a build with the game closed, and
 * a grey box is not a diagram. Written out as hex rather than as a CSS colour string because the
 * renderer parses the old `hsl(h,s%,l%)` form only, and the modern space-separated one comes out
 * black without complaining.
 */
export function colourOf(id: string, colors: Record<string, string>): string {
  if (colors[id]) return colors[id];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffff;
  return hslHex(hash % 360, 0.28, id.startsWith('minecraft:') ? 0.44 : 0.6);
}

function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const byte = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Ten colours for ten assemblies, spread rather than random so neighbours differ. */
export const PART_COLOURS = [
  '#7dd3fc', '#fbbf24', '#a3e635', '#f472b6', '#c084fc',
  '#5eead4', '#fb923c', '#93c5fd', '#f87171', '#facc15',
];
