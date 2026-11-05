import type { WorldData } from "./WorldData";
import { flagOf } from "./flags";

// Undo/redo for map edits.
//
// Rather than hooking every editor (border brush, build tool, nation and
// culture panels, flag editor...), the history compares the editable state of
// the world against a baseline after each user interaction and records the
// difference as one step. A step keeps only the cells and objects that
// changed, so a brush stroke costs a few kilobytes, not a copy of the map.
//
// Objects are restored in place rather than replaced: the history recorder,
// trade and the economy simulation key their state by object identity
// (WeakMaps of nations and cities), and that must survive an undo.

const CELL_FIELDS = ["nationIndex", "provinceIndex", "cultureIndex", "raceIndex"] as const;
type CellField = (typeof CELL_FIELDS)[number];

const COLLECTIONS = ["nations", "provinces", "cities", "cultures", "races", "worldRoads", "pois"] as const;
type CollectionKey = (typeof COLLECTIONS)[number];
type Obj = Record<string, unknown>;

const FLAGS = ["culturesEdited", "roadsEdited", "poisEdited"] as const;

// What the user sees in "Undid …": the parts of the world a step touched
const PART_NAMES: Record<CollectionKey | CellField | "relations", string> = {
  nationIndex: "borders",
  provinceIndex: "provinces",
  cultureIndex: "cultures",
  raceIndex: "races",
  nations: "nations",
  provinces: "provinces",
  cities: "cities",
  cultures: "cultures",
  races: "races",
  worldRoads: "roads",
  pois: "landmarks",
  relations: "diplomacy",
};

// Road point lists are long and only ever replaced, never edited in place, so
// a road is compared by its fields plus the identity of its point array.
const arrayIds = new WeakMap<object, number>();
let nextArrayId = 1;
function idOf(a: object) {
  let id = arrayIds.get(a);
  if (id === undefined) arrayIds.set(a, (id = nextArrayId++));
  return id;
}

interface Saved {
  sig: string; // compared to find changes
  data: unknown; // what restoring puts back
}

function saveObject(key: CollectionKey, o: Obj): Saved {
  if (key === "worldRoads") {
    const { points, ...rest } = o;
    const data = { ...o };
    return { sig: JSON.stringify(rest) + "#" + idOf(points as object), data };
  }
  const sig = JSON.stringify(o);
  return { sig, data: sig };
}

function loadObject(key: CollectionKey, o: Obj, data: unknown) {
  for (const k of Object.keys(o)) delete o[k];
  Object.assign(o, key === "worldRoads" ? data : JSON.parse(data as string));
}

export interface Snapshot {
  cells: Record<CellField, Int32Array>;
  order: Record<CollectionKey, Obj[]>;
  saved: Record<CollectionKey, Map<Obj, Saved>>;
  relations: string;
  languages: unknown[];
  flags: Record<(typeof FLAGS)[number], boolean>;
}

interface CollectionChange {
  before: Obj[];
  after: Obj[];
  // Objects whose content changed: content before and after (absent side = the object was added or removed)
  content: Map<Obj, { before?: unknown; after?: unknown }>;
}

export interface EditStep {
  label: string;
  cells: { idx: Int32Array; before: Int32Array; after: Int32Array; fields: CellField[] } | null;
  collections: Partial<Record<CollectionKey, CollectionChange>>;
  relations?: { before: string; after: string };
  languages?: { before: unknown[]; after: unknown[] };
  flags?: { before: Snapshot["flags"]; after: Snapshot["flags"] };
}

export interface RestoreResult {
  label: string;
  // Rows of the map whose ownership changed, for partial texture uploads
  rows: { y0: number; y1: number } | null;
  changed: Set<string>;
}

export function captureWorld(world: WorldData): Snapshot {
  // Flags are generated lazily the first time a nation is drawn; settle them
  // now so a first render never shows up as an edit
  for (let i = 0; i < world.nations.length; i++) flagOf(world, i);

  const W = world.width;
  const H = world.height;
  const N = W * H;
  const cells = {} as Snapshot["cells"];
  for (const f of CELL_FIELDS) cells[f] = new Int32Array(N);
  const { nationIndex: ni, provinceIndex: pi, cultureIndex: ci, raceIndex: ri } = cells;
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) {
      const c = col[y];
      const i = y * W + x;
      ni[i] = c.nationIndex ?? -1;
      pi[i] = c.provinceIndex ?? -1;
      ci[i] = c.cultureIndex ?? -1;
      ri[i] = c.raceIndex ?? -1;
    }
  }
  const order = {} as Snapshot["order"];
  const saved = {} as Snapshot["saved"];
  for (const key of COLLECTIONS) {
    const list = world[key] as unknown as Obj[];
    order[key] = list.slice();
    const m = new Map<Obj, Saved>();
    for (const o of list) m.set(o, saveObject(key, o));
    saved[key] = m;
  }
  return {
    cells,
    order,
    saved,
    relations: JSON.stringify(world.relations),
    languages: world.languages.slice(),
    flags: { culturesEdited: world.culturesEdited, roadsEdited: world.roadsEdited, poisEdited: world.poisEdited },
  };
}

const sameOrder = (a: Obj[], b: Obj[]) => a.length === b.length && a.every((o, i) => o === b[i]);

const capture = captureWorld;

// What changed from snapshot a to b, as a step that can go either way
export function diffWorld(a: Snapshot, b: Snapshot): EditStep | null {
  const parts = new Set<string>();

  // Cells: one pass, then pack the changed indices
  const N = a.cells.nationIndex.length;
  const changedIdx: number[] = [];
  const fieldsChanged = new Set<CellField>();
  for (let i = 0; i < N; i++) {
    let hit = false;
    for (const f of CELL_FIELDS)
      if (a.cells[f][i] !== b.cells[f][i]) {
        hit = true;
        fieldsChanged.add(f);
      }
    if (hit) changedIdx.push(i);
  }
  let cells: EditStep["cells"] = null;
  if (changedIdx.length) {
    const fields = CELL_FIELDS.filter((f) => fieldsChanged.has(f));
    const n = changedIdx.length;
    const before = new Int32Array(n * fields.length);
    const after = new Int32Array(n * fields.length);
    changedIdx.forEach((i, k) =>
      fields.forEach((f, j) => {
        before[k * fields.length + j] = a.cells[f][i];
        after[k * fields.length + j] = b.cells[f][i];
      }),
    );
    cells = { idx: Int32Array.from(changedIdx), before, after, fields };
    for (const f of fields) parts.add(PART_NAMES[f]);
  }

  const collections: EditStep["collections"] = {};
  for (const key of COLLECTIONS) {
    const content: CollectionChange["content"] = new Map();
    for (const [o, s] of a.saved[key]) {
      const t = b.saved[key].get(o);
      if (!t) content.set(o, { before: s.data });
      else if (t.sig !== s.sig) content.set(o, { before: s.data, after: t.data });
    }
    for (const [o, t] of b.saved[key]) if (!a.saved[key].has(o)) content.set(o, { after: t.data });
    if (content.size || !sameOrder(a.order[key], b.order[key])) {
      collections[key] = { before: a.order[key], after: b.order[key], content };
      parts.add(PART_NAMES[key]);
    }
  }

  const step: EditStep = { label: "", cells, collections };
  if (a.relations !== b.relations) {
    step.relations = { before: a.relations, after: b.relations };
    parts.add(PART_NAMES.relations);
  }
  if (!sameOrder(a.languages as Obj[], b.languages as Obj[])) step.languages = { before: a.languages, after: b.languages };
  if (FLAGS.some((f) => a.flags[f] !== b.flags[f])) step.flags = { before: a.flags, after: b.flags };

  if (!parts.size && !step.languages && !step.flags) return null;
  step.label = parts.size ? [...parts].join(", ") : "edit";
  return step;
}

// Border flags of the cells around `idx` follow the restored ownership
function refreshBorders(world: WorldData, idx: Int32Array) {
  const W = world.width;
  const H = world.height;
  const seen = new Set<number>();
  for (const i of idx) {
    const x0 = i % W;
    const y0 = (i - x0) / W;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const y = y0 + dy;
        if (y < 0 || y >= H) continue;
        const x = (((x0 + dx) % W) + W) % W;
        const k = y * W + x;
        if (seen.has(k)) continue;
        seen.add(k);
        const c = world.grid[x][y];
        const id = c.nationIndex ?? -1;
        let border = false;
        if (!c.isWater && id >= 0)
          for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ny = y + ey;
            if (ny < 0 || ny >= H) continue;
            const nb = world.grid[(((x + ex) % W) + W) % W][ny];
            if (nb.isWater || (nb.nationIndex ?? -1) !== id) border = true;
          }
        c.isNationBorder = border;
      }
  }
}

export class EditHistory {
  private undoStack: EditStep[] = [];
  private redoStack: EditStep[] = [];
  private base: Snapshot | null = null;
  private world: WorldData;
  public limit = 60;
  // Called whenever what can be undone or redone changes
  public onChange?: () => void;

  constructor(world: WorldData) {
    this.world = world;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoLabel() {
    return this.undoStack.at(-1)?.label;
  }
  get redoLabel() {
    return this.redoStack.at(-1)?.label;
  }
  get hasBaseline() {
    return this.base !== null;
  }

  // Take the current state as the starting point if there is none yet
  public ensureBaseline() {
    this.base ??= capture(this.world);
  }

  // Forget everything: a new world, or history moved the world on in ways
  // the edit steps cannot be replayed over
  public reset(world = this.world) {
    const had = this.undoStack.length || this.redoStack.length;
    this.world = world;
    this.undoStack = [];
    this.redoStack = [];
    this.base = null;
    if (had) this.onChange?.();
  }

  // Records what changed since the baseline as one step. Returns the step, or
  // null when nothing editable changed.
  public commit(): EditStep | null {
    if (!this.base) {
      this.base = capture(this.world);
      return null;
    }
    const now = capture(this.world);
    const step = diffWorld(this.base, now);
    this.base = now;
    if (!step) return null;
    this.undoStack.push(step);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
    return step;
  }

  public undo(): RestoreResult | null {
    // An edit made since the last commit is undone first
    this.commit();
    const step = this.undoStack.pop();
    if (!step) return null;
    const res = this.apply(step, "before");
    this.redoStack.push(step);
    this.onChange?.();
    return res;
  }

  public redo(): RestoreResult | null {
    if (this.commit()) return null; // a fresh edit drops the redo branch
    const step = this.redoStack.pop();
    if (!step) return null;
    const res = this.apply(step, "after");
    this.undoStack.push(step);
    this.onChange?.();
    return res;
  }

  private apply(step: EditStep, side: "before" | "after"): RestoreResult {
    const res = applyStep(this.world, step, side);
    // The restored state is the new baseline; capture it fresh so later
    // diffs compare against exactly what is on the map
    this.base = capture(this.world);
    return res;
  }
}

// Puts a step's before or after state onto the world, objects in place
export function applyStep(world: WorldData, step: EditStep, side: "before" | "after"): RestoreResult {
  const changed = new Set<string>();
  let rows: RestoreResult["rows"] = null;

  if (step.cells) {
    const { idx, fields } = step.cells;
    const vals = step.cells[side];
    const W = world.width;
    let y0 = Infinity;
    let y1 = -1;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const x = i % W;
      const y = (i - x) / W;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const c = world.grid[x][y];
      fields.forEach((f, j) => {
        const v = vals[k * fields.length + j];
        c[f] = v >= 0 ? v : f === "nationIndex" || f === "provinceIndex" ? v : undefined;
      });
    }
    for (const f of fields) changed.add(f);
    if (fields.includes("nationIndex")) {
      refreshBorders(world, idx);
      rows = { y0, y1 };
    }
  }

  for (const key of COLLECTIONS) {
    const ch = step.collections[key];
    if (!ch) continue;
    for (const [o, c] of ch.content) {
      const data = c[side];
      if (data !== undefined) loadObject(key, o, data);
    }
    (world as unknown as Record<string, Obj[]>)[key] = ch[side].slice();
    changed.add(key);
  }
  if (step.relations) {
    world.relations = JSON.parse(step.relations[side]);
    changed.add("relations");
  }
  if (step.languages) world.languages = step.languages[side].slice() as WorldData["languages"];
  if (step.flags) Object.assign(world, step.flags[side]);

  return { label: step.label, rows, changed };
}

// --- Compact snapshots, for history checkpoints ---

export interface PackedSnapshot extends Omit<Snapshot, "cells"> {
  cells: Record<CellField, Int32Array>; // run-length [value, count] pairs
  cellCount: number;
}

function rle(a: Int32Array): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < a.length; ) {
    const v = a[i];
    let j = i + 1;
    while (j < a.length && a[j] === v) j++;
    out.push(v, j - i);
    i = j;
  }
  return Int32Array.from(out);
}

function unrle(p: Int32Array, n: number): Int32Array {
  const out = new Int32Array(n);
  let o = 0;
  for (let k = 0; k < p.length; k += 2) {
    out.fill(p[k], o, o + p[k + 1]);
    o += p[k + 1];
  }
  return out;
}

export function packSnapshot(s: Snapshot): PackedSnapshot {
  const cells = {} as PackedSnapshot["cells"];
  for (const f of CELL_FIELDS) cells[f] = rle(s.cells[f]);
  return { ...s, cells, cellCount: s.cells.nationIndex.length };
}

export function unpackSnapshot(p: PackedSnapshot): Snapshot {
  const cells = {} as Snapshot["cells"];
  for (const f of CELL_FIELDS) cells[f] = unrle(p.cells[f], p.cellCount);
  const { cellCount: _n, ...rest } = p;
  return { ...rest, cells };
}

// Makes the world match a snapshot taken earlier (objects restored in place)
export function restoreWorld(world: WorldData, target: Snapshot): RestoreResult | null {
  const step = diffWorld(captureWorld(world), target);
  return step ? applyStep(world, step, "after") : null;
}
