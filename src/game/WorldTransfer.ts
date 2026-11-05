import { NoiseEngine } from "../core/NoiseEngine";
import { Language } from "./names";
import { WorldData, type CellData } from "./WorldData";
import { computeTrade } from "./generators/generateTrade";

// Moves a generated world from the generation worker to the main thread.
//
// Structured clone copies plain data, but the per-cell grid is 1.4 million
// small objects (slow to clone) and a few things are not plain data: the
// languages and the noise engine carry random streams that the history
// simulation keeps drawing from. So the grid travels as one typed array per
// field, and the random streams travel as their state and resume on the
// other side exactly where generation left them.

type Column =
  | { key: string; kind: "num"; values: Float64Array; present: Uint8Array }
  | { key: string; kind: "bool"; values: Uint8Array } // 0 absent, 1 false, 2 true
  | { key: string; kind: "str"; values: Int32Array; table: string[] } // -1 absent
  | { key: string; kind: "any"; values: unknown[] };

export interface PackedWorld {
  seed: number; // the noise engine's seed
  randomState: number;
  width: number;
  height: number;
  columns: Column[];
  languages: { family: number; onsets: string[] }[];
  fields: Record<string, unknown>; // every other WorldData property
}

const SKIP = new Set(["grid", "languages", "_sampler"]);

function packGrid(world: WorldData): Column[] {
  const W = world.width;
  const H = world.height;
  const N = W * H;
  const cols = new Map<string, Column>();
  const strIndex = new Map<string, Map<string, number>>();

  const toAny = (c: Column): Column => {
    const values: unknown[] = new Array(N);
    for (let i = 0; i < N; i++) values[i] = readColumn(c, i);
    return { key: c.key, kind: "any", values };
  };

  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      const cell = col[y] as unknown as Record<string, unknown>;
      for (const key in cell) {
        const v = cell[key];
        if (v === undefined) continue;
        let c = cols.get(key);
        const kind = typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : typeof v === "string" ? "str" : "any";
        if (!c) {
          c =
            kind === "num"
              ? { key, kind, values: new Float64Array(N), present: new Uint8Array(N) }
              : kind === "bool"
                ? { key, kind, values: new Uint8Array(N) }
                : kind === "str"
                  ? { key, kind, values: new Int32Array(N).fill(-1), table: [] }
                  : { key, kind: "any", values: new Array(N) };
          cols.set(key, c);
        } else if (c.kind !== kind && c.kind !== "any") {
          // Mixed types in one field: keep it exact, if slower
          c = toAny(c);
          cols.set(key, c);
        }
        switch (c.kind) {
          case "num":
            c.values[i] = v as number;
            c.present[i] = 1;
            break;
          case "bool":
            c.values[i] = v ? 2 : 1;
            break;
          case "str": {
            let m = strIndex.get(key);
            if (!m) strIndex.set(key, (m = new Map()));
            let k = m.get(v as string);
            if (k === undefined) {
              k = c.table.length;
              c.table.push(v as string);
              m.set(v as string, k);
            }
            c.values[i] = k;
            break;
          }
          case "any":
            c.values[i] = v;
        }
      }
    }
  }
  return [...cols.values()];
}

function readColumn(c: Column, i: number): unknown {
  switch (c.kind) {
    case "num":
      return c.present[i] ? c.values[i] : undefined;
    case "bool":
      return c.values[i] ? c.values[i] === 2 : undefined;
    case "str":
      return c.values[i] >= 0 ? c.table[c.values[i]] : undefined;
    case "any":
      return c.values[i];
  }
}

function unpackGrid(columns: Column[], W: number, H: number): CellData[][] {
  const grid: CellData[][] = new Array(W);
  for (let x = 0; x < W; x++) {
    const col: CellData[] = new Array(H);
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      const cell: Record<string, unknown> = {};
      for (const c of columns) {
        const v = readColumn(c, i);
        if (v !== undefined) cell[c.key] = v;
      }
      col[y] = cell as unknown as CellData;
    }
    grid[x] = col;
  }
  return grid;
}

// Buffers to hand over instead of copying
function collectBuffers(v: unknown, out: Set<ArrayBuffer>, depth = 0) {
  if (!v || typeof v !== "object" || depth > 3) return;
  if (ArrayBuffer.isView(v)) {
    if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    return;
  }
  if (Array.isArray(v)) return; // object lists are cloned, not scanned
  for (const x of Object.values(v)) collectBuffers(x, out, depth + 1);
}

export function packWorld(world: WorldData, noise: NoiseEngine, seed: number): { packed: PackedWorld; transfer: ArrayBuffer[] } {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(world)) if (!SKIP.has(k)) fields[k] = v;
  const packed: PackedWorld = {
    seed,
    randomState: noise.randomState,
    width: world.width,
    height: world.height,
    columns: packGrid(world),
    languages: world.languages.map((l) => l.spec),
    fields,
  };
  const buffers = new Set<ArrayBuffer>();
  collectBuffers(fields, buffers);
  for (const c of packed.columns) collectBuffers(c, buffers);
  return { packed, transfer: [...buffers] };
}

export function unpackWorld(p: PackedWorld): { world: WorldData; noise: NoiseEngine } {
  const noise = new NoiseEngine(p.seed);
  noise.randomState = p.randomState;
  // Skip the constructor: it would allocate a grid only to throw it away
  const world = Object.create(WorldData.prototype) as WorldData;
  Object.assign(world, p.fields);
  (world as unknown as { _sampler: null })._sampler = null;
  world.grid = unpackGrid(p.columns, p.width, p.height);
  // Generated languages draw names from the world's noise stream
  world.languages = p.languages.map((s) => Language.revive(s, noise.random));
  // Per-city trade figures live in a cache keyed by the city objects, which
  // stayed behind in the worker
  computeTrade(world);
  return { world, noise };
}
