import type { GPURenderer } from "../core/GPURenderer";
import { flagOf, renderFlag, type FlagSpec } from "../game/flags";
import type { WorldData } from "../game/WorldData";

// "Nations as flags": every realm's land is filled with its flag. The shader
// does the filling (MapShader, flagFill) so the flag is sampled per screen
// pixel, clipped by the same smooth coastlines and ownership edges as the
// political fill, with borders, rivers and labels drawn over it as usual.
// This module decides where each flag goes and keeps three textures current:
//   an atlas with one flag per realm (mipmapped, sized to the realm),
//   a table of flag copies ("placements": center and size in cells, atlas rect),
//   and per cell, which placement covers it.
// A realm's land is split into connected landmasses; those close together share
// one flag (an island off the coast shows the matching part of it) and far
// exclaves get a copy of their own.

export const FLAG_ASPECT = 1.5; // flags are drawn 3:2
const TINY = 16; // cells: a group this small shows its whole flag (contain fit)
const MAX_CROP = 2; // a cover fit may enlarge the flag at most this much past a contain fit
const PX_PER_CELL = 6;
const MAX_FLAG_PX = 512; // widest flag in the atlas
const DRAFT_PX = 48; // stand-in width while the full-size flag is painted // atlas resolution aimed for, flag pixels per cell
const PAD = 4; // atlas gutter, edge colors repeated (keeps mipmaps clean)
const THROTTLE_MS = 400; // territory rebuilds while it keeps changing (painting, history)

export interface FlagPlacement {
  nation: number;
  cx: number; // center, cells (x wrapped into [0, W))
  cy: number;
  w: number; // flag size, cells
  h: number;
}

export interface FlagLayout {
  placements: FlagPlacement[];
  cells: Uint16Array; // per cell (y * W + x): placement index + 1, 0 = none
}

interface Box {
  nation: number;
  x0: number; // unwrapped columns, inclusive
  x1: number;
  y0: number;
  y1: number;
  count: number;
  sx: number; // sums of unwrapped cell coordinates, for the centroid
  sy: number;
  id?: number; // index among the groups
}

// Where each realm's flag goes. `owner` is the nation per cell (-1 none), land
// is waterType 0. Owned water takes the placement of the nearest owned land.
export function layoutFlags(W: number, H: number, water: ArrayLike<number>, owner: ArrayLike<number>): FlagLayout {
  const N = W * H;
  const comp = new Int32Array(N).fill(-1);
  const ux = new Int32Array(N); // unwrapped column of each visited cell
  const queue = new Int32Array(N);
  const comps: Box[] = [];

  // Connected landmasses per realm (8-neighbors, across the date line)
  for (let i = 0; i < N; i++) {
    if (comp[i] >= 0 || water[i] !== 0) continue;
    const n = owner[i];
    if (n < 0) continue;
    const id = comps.length;
    const b: Box = { nation: n, x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, count: 0, sx: 0, sy: 0 };
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    comp[i] = id;
    ux[i] = i % W;
    while (head < tail) {
      const j = queue[head++];
      const x = j % W;
      const y = (j - x) / W;
      const u = ux[j];
      if (u < b.x0) b.x0 = u;
      if (u > b.x1) b.x1 = u;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      b.count++;
      b.sx += u;
      b.sy += y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const k = ny * W + ((x + dx + W) % W);
          if (comp[k] >= 0 || water[k] !== 0 || owner[k] !== n) continue;
          comp[k] = id;
          ux[k] = u + dx;
          queue[tail++] = k;
        }
      }
    }
    // A landmass ringing the world spans it once
    if (b.x1 - b.x0 + 1 > W) b.x1 = b.x0 + W - 1;
    comps.push(b);
  }

  // Group nearby landmasses of a realm, largest first: each group shares a flag
  const order = comps.map((_, i) => i).sort((a, b) => comps[b].count - comps[a].count);
  const groupsOf = new Map<number, Box[]>();
  const groupOfComp = new Int32Array(comps.length);
  const groups: Box[] = [];
  for (const ci of order) {
    const c = comps[ci];
    let list = groupsOf.get(c.nation);
    if (!list) groupsOf.set(c.nation, (list = []));
    let joined: Box | null = null;
    let shift = 0;
    for (const g of list) {
      const gap = Math.max(4, 0.25 * Math.max(g.x1 - g.x0 + 1, g.y1 - g.y0 + 1));
      // The copy of the landmass nearest the group, across the date line
      const s = Math.round((g.x0 + g.x1 - c.x0 - c.x1) / 2 / W) * W;
      if (c.x0 + s <= g.x1 + gap && c.x1 + s >= g.x0 - gap && c.y0 <= g.y1 + gap && c.y1 >= g.y0 - gap) {
        joined = g;
        shift = s;
        break;
      }
    }
    if (joined) {
      joined.x0 = Math.min(joined.x0, c.x0 + shift);
      joined.x1 = Math.max(joined.x1, c.x1 + shift);
      if (joined.x1 - joined.x0 + 1 > W) joined.x1 = joined.x0 + W - 1;
      joined.y0 = Math.min(joined.y0, c.y0);
      joined.y1 = Math.max(joined.y1, c.y1);
      joined.count += c.count;
      joined.sx += c.sx + shift * c.count;
      joined.sy += c.sy;
      groupOfComp[ci] = joined.id!;
    } else if (groups.length < 65534) {
      const g = { ...c, id: groups.length };
      list.push(g);
      groupOfComp[ci] = groups.length;
      groups.push(g);
    } else groupOfComp[ci] = (list[0] ?? groups[0]).id!;
  }

  // A flag per group: centered on its box, cover-fitted (cropped at most to
  // half the flag); tiny ones show the whole flag on their centroid
  const placements: FlagPlacement[] = groups.map((g) => {
    const w = g.x1 - g.x0 + 1;
    const h = g.y1 - g.y0 + 1;
    const cover = Math.max(w, h * FLAG_ASPECT);
    const contain = Math.min(w, h * FLAG_ASPECT);
    const tiny = g.count < TINY;
    const fw = tiny ? contain : Math.min(cover, contain * MAX_CROP);
    const cx = tiny ? g.sx / g.count + 0.5 : (g.x0 + g.x1 + 1) / 2;
    const cy = tiny ? g.sy / g.count + 0.5 : (g.y0 + g.y1 + 1) / 2;
    return { nation: g.nation, cx: ((cx % W) + W) % W, cy, w: fw, h: fw / FLAG_ASPECT };
  });

  // Per cell: land by its group, owned water by the nearest owned land
  const cells = new Uint16Array(N);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < N; i++)
    if (comp[i] >= 0) {
      cells[i] = groupOfComp[comp[i]] + 1;
      queue[tail++] = i;
    }
  while (head < tail) {
    const j = queue[head++];
    const x = j % W;
    const y = (j - x) / W;
    const n = owner[j];
    const visit = (k: number) => {
      if (cells[k] || owner[k] !== n) return;
      cells[k] = cells[j];
      queue[tail++] = k;
    };
    visit(y * W + ((x + 1) % W));
    visit(y * W + ((x - 1 + W) % W));
    if (y > 0) visit(j - W);
    if (y < H - 1) visit(j + W);
  }
  // Claims cut off from the realm's land (rare) take its main flag
  for (let i = 0; i < N; i++) {
    if (cells[i] || owner[i] < 0) continue;
    const g = groupsOf.get(owner[i])?.[0];
    if (g) cells[i] = g.id! + 1;
  }
  return { placements, cells };
}

const nextPow2 = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));

// Keeps the GPU's flag textures in step with the territory and the flags
export class FlagMapRenderer {
  private gpu: GPURenderer;
  private requestRender: () => void;
  private version = -1; // nations texture version the layout was built for
  private world: WorldData | null = null;
  private layout: FlagLayout | null = null;
  private builtAt = 0;
  private timer = 0;
  private atlasKey = "";
  private atlasRects: number[][] = []; // per nation: u0, v0, uw, vh (normalized)
  private flags: (FlagSpec | null)[] = []; // per nation, what the atlas holds
  private cantons: (FlagSpec | null)[] = [];
  private tiers: number[] = [];
  // Full-size flags, painted a few per tick after a draft atlas went up first
  // (a large flag takes tens of milliseconds to paint)
  private sharpFlags = new Map<string, HTMLCanvasElement>();
  private queue: { key: string; spec: FlagSpec; canton: FlagSpec | null; w: number; h: number }[] = [];
  private painting = 0;
  private redraw = false; // sharp flags arrived: rebuild the atlas
  private idle: (() => void)[] = [];

  constructor(gpu: GPURenderer, requestRender: () => void) {
    this.gpu = gpu;
    this.requestRender = requestRender;
  }

  // Cheap when nothing changed. `now` skips the throttle (exports).
  public sync(now = false) {
    const src = this.gpu.nationsSource;
    if (!src) return;
    const world = src.world;
    let placed = false;
    if (this.version !== this.gpu.nationsVersion || this.world !== world || !this.layout) {
      const t = performance.now();
      const fresh = this.world !== world || !this.layout;
      if (!now && !fresh && t - this.builtAt < THROTTLE_MS) {
        // Territory still changing: catch up a little later
        if (!this.timer)
          this.timer = window.setTimeout(() => {
            this.timer = 0;
            this.requestRender();
          }, THROTTLE_MS);
      } else {
        const W = world.width;
        const H = world.height;
        let owner: ArrayLike<number> | undefined = src.owner;
        if (!owner) {
          const o = new Int32Array(W * H).fill(-1);
          for (let x = 0; x < W; x++) {
            const col = world.grid[x];
            for (let y = 0; y < H; y++) {
              const n = col[y].nationIndex ?? -1;
              if (n >= 0 && n < world.nations.length) o[y * W + x] = n;
            }
          }
          owner = o;
        }
        this.layout = layoutFlags(W, H, world.waterType, owner);
        this.version = this.gpu.nationsVersion;
        this.world = world;
        this.builtAt = t;
        const rgba = new Uint8Array(W * H * 4);
        const cells = this.layout.cells;
        for (let i = 0; i < cells.length; i++) {
          const v = cells[i];
          if (!v) continue;
          rgba[i * 4] = v & 255;
          rgba[i * 4 + 1] = v >> 8;
          rgba[i * 4 + 3] = 255;
        }
        this.gpu.setFlagCells(rgba, W, H);
        placed = true;
      }
    }
    const layout = this.layout;
    if (!layout) return;
    if (this.refreshAtlas(world, layout)) placed = true;
    if (placed) this.uploadTable(layout);
  }

  // Rebuilds the atlas when a flag, an overlord (the canton) or a realm's size
  // tier changed. Returns whether it did.
  private refreshAtlas(world: WorldData, layout: FlagLayout): boolean {
    const count = world.nations.length;
    // Flag pixels per realm, by its largest copy
    const widest = new Float32Array(count);
    for (const p of layout.placements) if (p.nation < count) widest[p.nation] = Math.max(widest[p.nation], p.w);
    const tiers: number[] = [];
    for (let i = 0; i < count; i++) tiers.push(widest[i] > 0 ? Math.min(MAX_FLAG_PX, Math.max(32, nextPow2(widest[i] * PX_PER_CELL))) : 0);
    let same = count === this.flags.length && this.atlasKey !== "" && !this.redraw;
    for (let i = 0; same && i < count; i++) {
      const n = world.nations[i];
      const o = n.overlord;
      same = tiers[i] === this.tiers[i] && (n.flag ?? null) === this.flags[i] && (o !== undefined && tiers[i] ? (world.nations[o]?.flag ?? null) : null) === this.cantons[i];
    }
    if (same) return false;

    const specs = world.nations.map((_, i) => (tiers[i] ? flagOf(world, i) : null));
    const cantons = world.nations.map((n, i) => (n.overlord !== undefined && tiers[i] ? flagOf(world, n.overlord) : null));
    const key = JSON.stringify([tiers, specs, cantons]);
    this.flags = world.nations.map((n) => n.flag ?? null);
    this.cantons = cantons;
    this.tiers = tiers;
    if (key === this.atlasKey && !this.redraw) return false;
    this.atlasKey = key;
    this.redraw = false;

    // Shelf packing, tallest first; halve every flag until it fits
    const maxTex = Math.min(4096, this.gpu.maxTextureSize);
    const AW = Math.min(maxTex, 2048);
    let scale = 1;
    let slots: { i: number; w: number; h: number; x: number; y: number }[];
    let AH: number;
    for (;;) {
      slots = [];
      for (let i = 0; i < count; i++) {
        if (!tiers[i]) continue;
        const w = Math.max(16, Math.min(AW - 2 * PAD, Math.round(tiers[i] * scale)));
        slots.push({ i, w, h: Math.round(w / FLAG_ASPECT), x: 0, y: 0 });
      }
      slots.sort((a, b) => b.h - a.h);
      let x = 0;
      let y = 0;
      let rowH = 0;
      for (const s of slots) {
        const sw = s.w + 2 * PAD;
        if (x + sw > AW) {
          y += rowH;
          x = 0;
          rowH = 0;
        }
        s.x = x + PAD;
        s.y = y + PAD;
        x += sw;
        rowH = Math.max(rowH, s.h + 2 * PAD);
      }
      AH = y + rowH;
      if (AH <= maxTex || scale < 0.05) break;
      scale /= 2;
    }
    AH = Math.max(4, Math.min(maxTex, AH));
    const atlas = document.createElement("canvas");
    atlas.width = AW;
    atlas.height = AH;
    const g = atlas.getContext("2d")!;
    this.atlasRects = [];
    if (this.sharpFlags.size > 400) this.sharpFlags.clear();
    this.queue = [];
    for (const s of slots) {
      const spec = specs[s.i];
      if (!spec) continue;
      const { x, y, w, h } = s;
      const fkey = JSON.stringify([spec, cantons[s.i], w, h]);
      let flag = this.sharpFlags.get(fkey);
      if (!flag) {
        // A small draft now, the full flag soon
        flag = renderFlag(spec, Math.min(w, DRAFT_PX), Math.min(h, Math.round(DRAFT_PX / FLAG_ASPECT)), cantons[s.i]);
        if (w <= DRAFT_PX) this.sharpFlags.set(fkey, flag);
        else this.queue.push({ key: fkey, spec, canton: cantons[s.i], w, h });
      }
      g.imageSmoothingEnabled = flag.width < w;
      g.drawImage(flag, x, y, w, h);
      g.imageSmoothingEnabled = false;
      // Gutter: repeat the edge pixels outward
      g.drawImage(atlas, x, y, w, 1, x, y - PAD, w, PAD);
      g.drawImage(atlas, x, y + h - 1, w, 1, x, y + h, w, PAD);
      g.drawImage(atlas, x, y - PAD, 1, h + 2 * PAD, x - PAD, y - PAD, PAD, h + 2 * PAD);
      g.drawImage(atlas, x + w - 1, y - PAD, 1, h + 2 * PAD, x + w, y - PAD, PAD, h + 2 * PAD);
      this.atlasRects[s.i] = [x / AW, y / AH, w / AW, h / AH];
    }
    this.gpu.setFlagAtlas(atlas);
    atlas.width = atlas.height = 0; // uploaded; free the pixels
    this.paintQueue();
    return true;
  }

  // Paints the queued full-size flags a few at a time, then has the atlas rebuilt
  private paintQueue() {
    if (this.painting) return;
    if (!this.queue.length) {
      this.idle.splice(0).forEach((r) => r());
      return;
    }
    this.painting = window.setTimeout(() => {
      this.painting = 0;
      const t0 = performance.now();
      while (this.queue.length && performance.now() - t0 < 12) {
        const q = this.queue.shift()!;
        this.sharpFlags.set(q.key, renderFlag(q.spec, q.w, q.h, q.canton));
      }
      if (this.queue.length) this.paintQueue();
      else {
        this.redraw = true;
        this.requestRender();
        this.idle.splice(0).forEach((r) => r());
      }
    }, 0);
  }

  // Resolves once every flag is painted at full size (exports wait for it)
  public async sharp(): Promise<void> {
    for (let k = 0; k < 4; k++) {
      this.sync(true);
      if (!this.queue.length && !this.painting && !this.redraw) return;
      await new Promise<void>((r) => this.idle.push(r));
    }
  }

  // Placement table: two RGBA32F texels per placement (index 0 unused):
  // center and size in cells, then the atlas rectangle
  private uploadTable(layout: FlagLayout) {
    const n = layout.placements.length + 1;
    const TW = Math.min(2048, n * 2);
    const TH = Math.ceil((n * 2) / TW);
    const data = new Float32Array(TW * TH * 4);
    layout.placements.forEach((p, k) => {
      const r = this.atlasRects[p.nation];
      if (!r) return;
      const o = (k + 1) * 8;
      data.set([p.cx, p.cy, p.w, p.h, r[0], r[1], r[2], r[3]], o);
    });
    this.gpu.setFlagPlaces(data, TW, TH);
  }
}
