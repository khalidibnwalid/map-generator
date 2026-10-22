import type { City, WorldData } from "../game/WorldData";
import { CELL_METERS } from "../core/FieldNoise";
import type { MapTheme } from "../core/GPURenderer";
import {
  buildCityLayout,
  buildWardDetail,
  type CityLayout,
  type CityStyle,
  type Landmark,
  type Ward,
  type WardDetail,
} from "../game/city/CityLayout";
import { type Poly, insetConvex } from "../game/city/geom";
import { THEMES, viewRect } from "./themes";

// Level of detail, by pixels per meter (ppm = scale / 5000):
//   dot       city core < ~5 px across
//   footprint wards as tinted blobs, walls, fields
//   blocks    streets, blocks, landmarks, piers           (ppm > 0.03)
//   buildings individual roofs, trees, stalls, boats      (ppm > 0.09)
// Layouts and ward details are generated in time-sliced background work, so
// zooming never blocks the UI; coarser LODs are drawn until detail is ready.

const LOD_BLOCKS = 0.03;
const LOD_BUILDINGS = 0.22; // ~2 px per 10 m roof
const MAX_LAYOUTS = 28;
const FRAME_BUDGET_MS = 9;

function path(polys: Poly[], offX = 0, offY = 0): Path2D {
  const p = new Path2D();
  for (const poly of polys) {
    if (poly.length < 3) continue;
    p.moveTo(poly[0].x + offX, poly[0].y + offY);
    for (let i = 1; i < poly.length; i++) p.lineTo(poly[i].x + offX, poly[i].y + offY);
    p.closePath();
  }
  return p;
}

function circles(xyr: number[], scaleR = 1, offX = 0, offY = 0): Path2D {
  const p = new Path2D();
  for (let i = 0; i < xyr.length; i += 3) {
    const r = xyr[i + 2] * scaleR;
    p.moveTo(xyr[i] + offX + r, xyr[i + 1] + offY);
    p.arc(xyr[i] + offX, xyr[i + 1] + offY, r, 0, Math.PI * 2);
  }
  return p;
}

// 0..1 visibility of a settlement marker/label at a given zoom
export function settlementFade(city: City, scale: number): number {
  if (city.isCapital || city.size >= 2) return 1;
  const ramp = (a: number, b: number) => Math.max(0, Math.min(1, (scale - a) / (b - a)));
  if (city.size === 1) return ramp(1.6, 2.6);
  return city.population > 1500 ? ramp(4, 6) : ramp(6, 9);
}

function shade(hex: string, amt: number): string {
  const v = parseInt(hex.slice(1), 16);
  const f = (s: number) => {
    const c = (v >> s) & 255;
    const t = amt >= 0 ? c + (255 - c) * amt : c * (1 + amt);
    return Math.round(Math.max(0, Math.min(255, t)));
  };
  return `rgb(${f(16)},${f(8)},${f(0)})`;
}

interface ThemedStyle extends CityStyle {
  outline: string | null;
  shadow: string | null;
  roofLight: string[];
  roofDark: string[];
  wRoofLight: string[];
  wRoofDark: string[];
  roofShades: string[][]; // [palette][shade 0..3]
  wRoofShades: string[][];
  dome: string;
  water: string;
  stone: string;
  stoneDark: string;
}

const SHADE_STEPS = [-0.3, -0.15, 0, 0.12];
const shadesOf = (cs: string[]) => cs.map((c) => SHADE_STEPS.map((k) => shade(c, k)));

function themed(s: CityStyle, theme: MapTheme): ThemedStyle {
  const t = themedBase(s, theme);
  const flatten = theme === "Atlas";
  return {
    ...t,
    roofShades: flatten ? t.roofLight.map((c) => [c, c, c, c]) : shadesOf(theme === "Historical" ? t.roofLight : s.roofs),
    wRoofShades: flatten ? t.wRoofLight.map((c) => [c, c, c, c]) : shadesOf(theme === "Historical" ? t.wRoofLight : s.wealthyRoofs),
    dome: theme === "Atlas" ? "#bdb6ab" : theme === "Historical" ? "#cbb48c" : s.domeColor ?? "#79a6b6",
  };
}

function themedBase(s: CityStyle, theme: MapTheme): Omit<ThemedStyle, "roofShades" | "wRoofShades" | "dome"> {
  if (theme === "Historical") {
    const roof = ["#d4b48a", "#c9a77c", "#dcbf98"];
    return {
      ...s,
      ground: "#e7d7b0",
      street: "#e9dbb8",
      yard: "#dccb9e",
      plaza: "#eee2c4",
      fields: ["#d9cc98", "#cfc58e", "#e0d2a2", "#c8bf8a"],
      tree: "#9aa070",
      treeDark: "#5b5636",
      wall: "#d8c7a0",
      wallDark: "#3b2a1c",
      outline: "#3b2a1c",
      shadow: null,
      roofLight: roof,
      roofDark: roof.map((c) => shade(c, -0.12)),
      wRoofLight: ["#c8b590"],
      wRoofDark: [shade("#c8b590", -0.12)],
      water: "#a9bcb6",
      stone: "#d8c7a0",
      stoneDark: "#3b2a1c",
    };
  }
  if (theme === "Atlas") {
    return {
      ...s,
      ground: "#e6e1d8",
      street: "#ffffff",
      yard: "#ebe6dd",
      plaza: "#f2efe9",
      fields: ["#e3ead2", "#e9ecd6", "#dfe6cc"],
      tree: "#b9d4a0",
      treeDark: "#8fb27a",
      outline: null,
      shadow: null,
      roofLight: ["#cfc6ba"],
      roofDark: ["#cfc6ba"],
      wRoofLight: ["#c4bcb0"],
      wRoofDark: ["#c4bcb0"],
      water: "#aacbe6",
      stone: "#bdb6ab",
      stoneDark: "#8d867b",
    };
  }
  return {
    ...s,
    outline: null,
    shadow: "rgba(30, 22, 15, 0.28)",
    roofLight: s.roofs.map((c) => shade(c, 0.1)),
    roofDark: s.roofs.map((c) => shade(c, -0.2)),
    wRoofLight: s.wealthyRoofs.map((c) => shade(c, 0.12)),
    wRoofDark: s.wealthyRoofs.map((c) => shade(c, -0.22)),
    water: "#2f6f96",
    stone: s.wall,
    stoneDark: s.wallDark,
  };
}

// Cached Path2D objects for one ward's detail
interface WardPaths {
  blocks: Path2D;
  plazas: Path2D;
  shadow: Path2D;
  roofs: Path2D[][]; // [palette][shade]
  wRoofs: Path2D[][];
  domes: number[];
  minarets: Path2D;
  outline: Path2D;
  trees: Path2D;
  treeShadow: Path2D;
  treeLight: Path2D;
  stalls: Path2D;
  graves: Path2D;
  ponds: Path2D;
  hedges: Path2D;
  paths: Path2D;
  landmarks: Landmark[];
  hasTrees: boolean;
}

interface Entry {
  layout: CityLayout | null;
  job: Generator<void, CityLayout> | null;
  lastUsed: number;
  wardPaths: Map<Ward, WardPaths>;
  pathsTheme?: MapTheme;
  // Footprint-level caches
  ground?: Path2D; // paved town wards
  grass?: Path2D; // suburbs / village green
  wardEdges?: Path2D;
  landClip?: Path2D;
  quays?: Path2D;
  urbanBlobs?: Path2D;
  fieldPaths?: { color: number; alpha: number; path: Path2D }[];
  farmTrees?: Path2D;
  farmBuildings?: Path2D;
  arteries?: { width: number; path: Path2D }[];
  wallPath?: Path2D;
  piers?: Path2D;
}

export class CityRenderer {
  private world: WorldData | null = null;
  private entries = new Map<City, Entry>();
  private detailQueue: { entry: Entry; ward: Ward; priority: number }[] = [];
  private queuedWards = new Set<Ward>();
  private layoutQueue: { city: City; priority: number }[] = [];
  private workScheduled = false;
  private frame = 0;
  public onNeedsRender: (() => void) | null = null;
  public hoveredNationIndex = -1;
  // Offscreen layer holding the last full city render; reused (transformed)
  // while the user pans/zooms so heavy cities never stall interaction.
  private layer = document.createElement("canvas");
  private layerState: { scale: number; offX: number; offY: number; theme: MapTheme; world: WorldData; dirty: boolean } | null = null;
  private placeholders = new WeakMap<Ward, Path2D | null>();
  private interacting = false;
  private lastTheme: MapTheme = "Realistic";
  private lastProgressRender = 0;
  private progressTimer: number | null = null;

  private reset(world: WorldData) {
    this.world = world;
    this.entries.clear();
    this.detailQueue = [];
    this.queuedWards.clear();
    this.layoutQueue = [];
    this.layerState = null;
  }

  public invalidateCity(city: City) {
    this.entries.delete(city);
    this.layerState = null;
  }

  public invalidateAll() {
    if (this.world) this.reset(this.world);
  }

  // Approximate farmland reach before a layout exists
  private extentM(city: City) {
    const Ru = city.radiusM * (city.size === 0 ? 1.25 : 1.35);
    return { Ru, Rf: Ru + Math.min(2500, Math.max(450, 300 + city.radiusM * 0.8)) };
  }

  private schedule() {
    if (this.workScheduled) return;
    this.workScheduled = true;
    setTimeout(() => this.work(), 0);
  }

  private work() {
    this.workScheduled = false;
    // Never compete with an ongoing pan/zoom
    if (this.interacting) {
      this.workScheduled = true;
      setTimeout(() => this.work(), 150);
      return;
    }
    const t0 = performance.now();
    let progressed = false;
    this.layoutQueue.sort((a, b) => a.priority - b.priority);
    while (performance.now() - t0 < FRAME_BUDGET_MS && this.layoutQueue.length > 0) {
      const { city } = this.layoutQueue[0];
      const e = this.entries.get(city);
      if (!e || e.layout || !this.world) {
        this.layoutQueue.shift();
        continue;
      }
      if (!e.job) e.job = buildCityLayout(this.world, city);
      while (performance.now() - t0 < FRAME_BUDGET_MS) {
        const r = e.job.next();
        if (r.done) {
          e.layout = r.value;
          e.job = null;
          this.layoutQueue.shift();
          progressed = true;
          break;
        }
      }
    }
    this.detailQueue.sort((a, b) => a.priority - b.priority);
    while (performance.now() - t0 < FRAME_BUDGET_MS && this.detailQueue.length > 0) {
      const { entry, ward } = this.detailQueue.shift()!;
      this.queuedWards.delete(ward);
      if (!entry.layout || ward.detail) continue;
      ward.detail = buildWardDetail(entry.layout, ward);
      this.syncTheme(entry, this.lastTheme);
      this.wardPaths(entry, ward, ward.detail, themed(entry.layout.style, this.lastTheme));
      progressed = true;
    }
    if (progressed) {
      if (this.layerState) this.layerState.dirty = true;
      // Throttle redraws caused by background progress
      const now = performance.now();
      if (now - this.lastProgressRender > 250) {
        this.lastProgressRender = now;
        this.onNeedsRender?.();
      } else if (this.progressTimer === null) {
        this.progressTimer = setTimeout(() => {
          this.progressTimer = null;
          this.lastProgressRender = performance.now();
          this.onNeedsRender?.();
        }, 260) as unknown as number;
      }
    }
    if (this.layoutQueue.length > 0 || this.detailQueue.length > 0) this.schedule();
  }

  private evict() {
    if (this.entries.size <= MAX_LAYOUTS) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - MAX_LAYOUTS; i++) {
      const [city, e] = sorted[i];
      if (e.lastUsed === this.frame) break;
      this.entries.delete(city);
    }
  }

  public render(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    theme: MapTheme,
    isInteracting: boolean,
  ) {
    if (world !== this.world) this.reset(world);
    this.frame++;
    this.interacting = isInteracting;
    this.lastTheme = theme;
    const ppm = scale / CELL_METERS;
    const v = viewRect(width, height, scale, offsetX, offsetY);
    const W = world.width;
    const ct = THEMES[theme];

    const dots: { city: City; sx: number; sy: number; alpha: number }[] = [];
    const detailed: { city: City; e: Entry; sx: number; sy: number; alpha: number }[] = [];

    for (const city of world.cities) {
      const { Ru, Rf } = this.extentM(city);
      const RfC = Rf / CELL_METERS;
      if (city.y + RfC < v.y0 || city.y - RfC > v.y1) continue;
      const k0 = Math.floor((v.x0 - RfC - city.x) / W);
      const k1 = Math.ceil((v.x1 + RfC - city.x) / W);
      for (let k = k0; k <= k1; k++) {
        const cx = city.x + k * W;
        if (cx + RfC < v.x0 || cx - RfC > v.x1) continue;
        const sx = cx * scale + offsetX;
        const sy = city.y * scale + offsetY;
        const rpx = Ru * ppm;
        if (rpx < 5) {
          dots.push({ city, sx, sy, alpha: 1 });
          continue;
        }
        let e = this.entries.get(city);
        if (!e) {
          e = { layout: null, job: null, lastUsed: this.frame, wardPaths: new Map() };
          this.entries.set(city, e);
        }
        e.lastUsed = this.frame;
        const blend = Math.min(1, (rpx - 5) / 10);
        if (!e.layout) {
          const pr = Math.hypot(sx - width / 2, sy - height / 2);
          if (!this.layoutQueue.some((q) => q.city === city)) this.layoutQueue.push({ city, priority: pr });
          this.schedule();
          dots.push({ city, sx, sy, alpha: 1 });
          continue;
        }
        if (blend < 1) dots.push({ city, sx, sy, alpha: 1 - blend });
        detailed.push({ city, e, sx, sy, alpha: blend });
      }
    }

    const ls = this.layerState;
    const ratio = ls ? scale / ls.scale : 0;
    const compatible =
      !!ls && ls.world === world && ls.theme === theme && this.layer.width === width && this.layer.height === height;
    const unchanged = compatible && !ls!.dirty && ls!.scale === scale && ls!.offX === offsetX && ls!.offY === offsetY;
    const canBlit = compatible && (unchanged || (isInteracting && ratio > 0.08 && ratio < 12));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (canBlit) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.layer, offsetX - ls!.offX * ratio, offsetY - ls!.offY * ratio, width * ratio, height * ratio);
    } else if (detailed.length > 0) {
      if (this.layer.width !== width || this.layer.height !== height) {
        this.layer.width = width;
        this.layer.height = height;
      }
      const lctx = this.layer.getContext("2d")!;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, width, height);
      // Mid-gesture without a usable cache: draw a fast, low-detail pass
      for (const d of detailed) this.drawCity(lctx, d.e, d.e.layout!, d.sx, d.sy, ppm, d.alpha, theme, width, height, isInteracting);
      if (isInteracting) {
        ctx.drawImage(this.layer, 0, 0);
        ctx.restore();
        this.layerState = { scale, offX: offsetX, offY: offsetY, theme, world, dirty: true };
        this.afterCities(ctx, dots, detailed, scale, ppm, theme, ct.cityDot);
        return;
      }
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalAlpha = 1;
      ctx.drawImage(this.layer, 0, 0);
      this.layerState = { scale, offX: offsetX, offY: offsetY, theme, world, dirty: false };
    } else {
      this.layerState = null;
    }
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    this.afterCities(ctx, dots, detailed, scale, ppm, theme, ct.cityDot);
  }

  private afterCities(
    ctx: CanvasRenderingContext2D,
    dots: { city: City; sx: number; sy: number; alpha: number }[],
    detailed: { city: City; e: Entry; sx: number; sy: number; alpha: number }[],
    scale: number,
    ppm: number,
    theme: MapTheme,
    dotColor: string,
  ) {
    this.drawDots(ctx, dots, scale, dotColor, theme);
    if (ppm > 0.22) for (const d of detailed) this.drawStreetLabels(ctx, d.e.layout!, d.sx, d.sy, ppm, theme);
    for (const d of detailed) {
      // Only once the city spans a good part of the screen
      if (d.e.layout!.Ru * ppm > 260) this.drawDistrictLabels(ctx, d.e.layout!, d.sx, d.sy, ppm, theme);
    }
    this.evict();
  }

  private drawDots(
    ctx: CanvasRenderingContext2D,
    dots: { city: City; sx: number; sy: number; alpha: number }[],
    scale: number,
    color: string,
    theme: MapTheme,
  ) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    dots.sort((a, b) => a.city.size - b.city.size);
    for (const { city, sx, sy, alpha: a0 } of dots) {
      // Settlement tiers fade in with zoom: capitals & cities always, towns
      // from mid zoom, villages only up close.
      const tierFade = settlementFade(city, scale);
      if (tierFade <= 0) continue;
      const alpha = a0 * tierFade;
      const hovered = city.nationIndex === this.hoveredNationIndex;
      const base = city.isCapital ? 1.3 : city.size === 2 ? 1.0 : city.size === 1 ? 0.8 : 0.4;
      const r = Math.max(1, Math.min(city.isCapital ? 6 : 4.5, base * scale));
      ctx.globalAlpha = alpha * (hovered ? 1 : city.isCapital ? 0.85 : 0.6);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      if (theme === "Realistic") {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.fillStyle = theme === "Historical" ? "#efe2c2" : "#ffffff";
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = color;
        ctx.stroke();
        if (city.isCapital) {
          ctx.beginPath();
          ctx.arc(sx, sy, r * 0.45, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
      if (city.isCapital && theme === "Realistic" && r > 2.5) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private ensureFootprint(e: Entry, L: CityLayout) {
    if (e.ground) return;
    const rural = (w: Ward) => w.type === "suburb" || w.type === "green";
    e.ground = path(L.wards.filter((w) => !rural(w)).map((w) => w.poly));
    e.grass = path(L.wards.filter(rural).map((w) => w.poly));
    e.wardEdges = path(L.wards.filter((w) => !rural(w)).map((w) => w.poly));
    // Land clip: everything minus water loops (even-odd)
    const clip = new Path2D();
    const big = L.Rf + 200;
    clip.rect(-big, -big, big * 2, big * 2);
    clip.addPath(path(L.waterLoops));
    e.landClip = clip;
    const q = new Path2D();
    for (const loop of L.waterLoops) {
      if (loop.length < 2) continue;
      q.moveTo(loop[0].x, loop[0].y);
      for (const p of loop) q.lineTo(p.x, p.y);
      q.closePath();
    }
    e.quays = q;
    e.urbanBlobs = path(
      L.wards
        .filter((w) => w.type !== "park" && w.type !== "cemetery")
        .map((w) => insetConvex(w.poly, 6))
        .filter((p): p is Poly => !!p),
    );
    const buckets = new Map<string, { color: number; alpha: number; polys: Poly[] }>();
    for (const f of L.fields) {
      const a = Math.round(f.alpha * 4) / 4;
      if (a <= 0) continue;
      const key = `${f.color}|${a}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { color: f.color, alpha: a, polys: [] }));
      b.polys.push(f.poly);
    }
    e.fieldPaths = [...buckets.values()].map((b) => ({ color: b.color, alpha: b.alpha, path: path(b.polys) }));
    e.farmTrees = circles(L.farmTrees);
    e.farmBuildings = path(L.farmBuildings);
    e.arteries = L.arteries.map((a) => {
      const p = new Path2D();
      p.moveTo(a.pts[0].x, a.pts[0].y);
      for (const q2 of a.pts) p.lineTo(q2.x, q2.y);
      return { width: a.width, path: p };
    });
    if (L.wall) {
      const wp = new Path2D();
      for (const [a, b] of L.wall.segments) {
        wp.moveTo(a.x, a.y);
        wp.lineTo(b.x, b.y);
      }
      e.wallPath = wp;
    }
    e.piers = path(L.piers);
  }

  private syncTheme(e: Entry, theme: MapTheme) {
    if (e.pathsTheme !== theme) {
      e.wardPaths.clear();
      e.pathsTheme = theme;
    }
  }

  private wardPaths(e: Entry, ward: Ward, D: WardDetail, st: ThemedStyle): WardPaths {
    let wp = e.wardPaths.get(ward);
    if (wp) return wp;
    wp = this.buildPaths(D, st);
    e.wardPaths.set(ward, wp);
    return wp;
  }

  private buildPaths(D: WardDetail, st: ThemedStyle): WardPaths {
    let wp: WardPaths;
    const bucketPolys = (n: number) => Array.from({ length: n }, () => [[], [], [], []] as Poly[][]);
    const roofs = bucketPolys(st.roofShades.length);
    const wRoofs = bucketPolys(st.wRoofShades.length);
    const all: Poly[] = [];
    for (const b of D.buildings) {
      const target = b.wealthy ? wRoofs : roofs;
      const set = target[b.bucket % target.length];
      b.faces.forEach((f, i) => set[b.shades[i]].push(f));
      all.push(b.faces[0]);
      for (let i = 1; i < b.faces.length; i++) if (!st.flat) all.push(b.faces[i]);
    }
    const pathsP = new Path2D();
    for (const pl of D.paths) {
      pathsP.moveTo(pl[0].x, pl[0].y);
      for (const p of pl) pathsP.lineTo(p.x, p.y);
    }
    wp = {
      blocks: path(D.blocks),
      plazas: path(D.plazas),
      shadow: path(all, 2.2, 2.2),
      roofs: roofs.map((sh) => sh.map((p) => path(p))),
      wRoofs: wRoofs.map((sh) => sh.map((p) => path(p))),
      domes: D.domes,
      minarets: circles(D.minarets),
      outline: path(all),
      trees: circles(D.trees),
      treeShadow: circles(D.trees, 1, 1.6, 1.6),
      treeLight: circles(D.trees, 0.55, -0.6, -0.6),
      stalls: path(D.stalls),
      graves: path(D.graves),
      ponds: path(D.ponds),
      hedges: path(D.hedges),
      paths: pathsP,
      landmarks: D.landmarks,
      hasTrees: D.trees.length > 0,
    };
    return wp;
  }

  private drawCity(
    ctx: CanvasRenderingContext2D,
    e: Entry,
    L: CityLayout,
    sx: number,
    sy: number,
    ppm: number,
    alpha: number,
    theme: MapTheme,
    width: number,
    height: number,
    isInteracting: boolean,
  ) {
    this.ensureFootprint(e, L);
    const st = themed(L.style, theme);
    const px = 1 / ppm; // meters per pixel
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setTransform(ppm, 0, 0, ppm, sx, sy);

    // Visible window in local meters
    const vx0 = -sx / ppm;
    const vy0 = -sy / ppm;
    const vx1 = (width - sx) / ppm;
    const vy1 = (height - sy) / ppm;

    ctx.save();
    ctx.clip(e.landClip!, "evenodd");

    // Fields
    if (ppm > 0.008 && e.fieldPaths) {
      for (const f of e.fieldPaths) {
        ctx.globalAlpha = alpha * f.alpha * (theme === "Atlas" ? 0.6 : 0.85);
        ctx.fillStyle = st.fields[f.color % st.fields.length];
        ctx.fill(f.path);
        if (theme === "Historical" && ppm > 0.02) {
          ctx.strokeStyle = "rgba(59,42,28,0.35)";
          ctx.lineWidth = 0.8 * px;
          ctx.stroke(f.path);
        }
      }
      ctx.globalAlpha = alpha;
    }

    // Urban ground (streets are the gaps between blocks)
    ctx.fillStyle = st.yard;
    ctx.fill(e.grass!);
    ctx.fillStyle = st.ground;
    ctx.fill(e.ground!);
    ctx.restore();

    // Quays along urban waterfronts
    if (ppm > 0.025) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, L.Ru * 0.98, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = st.stoneDark;
      ctx.lineWidth = Math.max(2.5, 1.2 * px);
      ctx.stroke(e.quays!);
      ctx.restore();
    }

    if (ppm > 0.05) {
      ctx.fillStyle = theme === "Historical" ? "#c9b38a" : "#8a6f55";
      ctx.fill(e.farmBuildings!);
      if (ppm > 0.08 && !isInteracting) {
        ctx.fillStyle = st.treeDark;
        ctx.fill(e.farmTrees!);
      }
    }

    const drawRoads = () => {
    // Street network between wards stays legible at every zoom
    if (ppm > 0.012) {
      ctx.strokeStyle = st.street;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(5, 1.1 * px);
      ctx.stroke(e.wardEdges!);
    }
    // Arteries
    for (const a of e.arteries!) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (ppm > 0.05 && theme !== "Historical") {
        ctx.strokeStyle = "rgba(90,70,50,0.35)";
        ctx.lineWidth = a.width + 2.5;
        ctx.stroke(a.path);
      }
      ctx.strokeStyle = st.street;
      ctx.lineWidth = Math.max(a.width, 1.2 * px);
      ctx.stroke(a.path);
    }

    // Bridges
    for (const b of L.bridges) {
      ctx.lineCap = "butt";
      ctx.strokeStyle = st.stoneDark;
      ctx.lineWidth = Math.max(b.width + 3, 2 * px);
      ctx.beginPath();
      ctx.moveTo(b.a.x, b.a.y);
      ctx.lineTo(b.b.x, b.b.y);
      ctx.stroke();
      ctx.strokeStyle = st.stone;
      ctx.lineWidth = Math.max(b.width, 1.4 * px);
      ctx.stroke();
    }
    };

    // Wards
    const showDetail = ppm > LOD_BLOCKS;
    const showBuildings = ppm > LOD_BUILDINGS && !isInteracting;
    if (!showDetail) {
      ctx.fillStyle = st.roofDark[0];
      ctx.globalAlpha = alpha * 0.75;
      ctx.fill(e.urbanBlobs!);
      ctx.globalAlpha = alpha;
      drawRoads();
    } else {
      this.syncTheme(e, theme);
      const visible: { w: Ward; p: WardPaths | null }[] = [];
      for (const w of L.wards) {
        const b = w.bbox;
        if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
        if (!w.detail) {
          if (!this.queuedWards.has(w)) {
            this.queuedWards.add(w);
            this.detailQueue.push({
              entry: e,
              ward: w,
              priority: Math.hypot(sx + w.c.x * ppm - width / 2, sy + w.c.y * ppm - height / 2),
            });
            this.schedule();
          }
          visible.push({ w, p: null });
        } else visible.push({ w, p: this.wardPaths(e, w, w.detail, st) });
      }
      this.drawWards(ctx, visible, st, ppm, px, showBuildings, isInteracting, theme, drawRoads);
    }

    // Walls
    if (e.wallPath && L.wall) {
      ctx.lineCap = "round";
      ctx.strokeStyle = st.stoneDark;
      ctx.lineWidth = Math.max(7, 2.2 * px);
      ctx.stroke(e.wallPath);
      ctx.strokeStyle = st.wall;
      ctx.lineWidth = Math.max(4.5, 1.2 * px);
      ctx.stroke(e.wallPath);
      if (ppm > 0.02) {
        const towers = circles(L.wall.towers.flatMap((t) => [t.x, t.y, Math.max(7, 2 * px)]));
        ctx.fillStyle = st.wall;
        ctx.fill(towers);
        ctx.lineWidth = Math.max(1.5, 0.8 * px);
        ctx.strokeStyle = st.stoneDark;
        ctx.stroke(towers);
        const gates = circles(L.wall.gates.flatMap((g) => [g.x, g.y, Math.max(9, 2.5 * px)]));
        ctx.fillStyle = st.stoneDark;
        ctx.fill(gates);
      }
    }

    // Harbor
    if (ppm > 0.02 && L.piers.length) {
      ctx.fillStyle = theme === "Historical" ? "#b89a70" : "#7a5c3e";
      ctx.fill(e.piers!);
      if (ppm > 0.06) {
        ctx.strokeStyle = "rgba(40,28,18,0.6)";
        ctx.lineWidth = 0.8 * px;
        ctx.stroke(e.piers!);
      }
    }
    if (ppm > 0.05) this.drawBoats(ctx, L, theme);

    for (const lm of L.landmarks) this.drawLandmark(ctx, lm, st, ppm, px);

    ctx.restore();
  }

  private drawWards(
    ctx: CanvasRenderingContext2D,
    visible: { w: Ward; p: WardPaths | null }[],
    st: ThemedStyle,
    ppm: number,
    px: number,
    showBuildings: boolean,
    isInteracting: boolean,
    theme: MapTheme,
    drawRoads: () => void,
  ) {
    // Placeholder for wards still generating
    for (const { w, p } of visible) {
      if (p) continue;
      let ph = this.placeholders.get(w);
      if (ph === undefined) {
        const inner = insetConvex(w.poly, 5);
        ph = inner ? path([inner]) : null;
        this.placeholders.set(w, ph);
      }
      if (!ph) continue;
      ctx.fillStyle = w.type === "park" ? st.tree : st.roofDark[0];
      ctx.fill(ph);
    }
    const ready = visible.filter((v) => v.p).map((v) => ({ w: v.w, p: v.p! }));

    const openWard = (t: string) => t === "market" || t === "cathedral" || t === "green" || t === "castle";
    for (const { w, p } of ready) {
      ctx.fillStyle = w.type === "park" ? st.yard : w.type === "cemetery" ? st.yard : w.type === "green" ? st.yard : st.plaza;
      ctx.fill(p.plazas);
      if (openWard(w.type)) continue;
      ctx.fillStyle = w.type === "suburb" ? shade(st.yard, -0.04) : st.yard;
      ctx.fill(p.blocks);
      if (w.type === "park" || w.type === "palace") {
        ctx.fillStyle = shade(st.tree, 0.25);
        ctx.fill(p.plazas);
      }
    }
    for (const { p } of ready) {
      ctx.fillStyle = st.water;
      ctx.fill(p.ponds);
      ctx.strokeStyle = st.treeDark;
      ctx.lineWidth = Math.max(1.5, 0.8 * px);
      ctx.stroke(p.hedges);
      ctx.strokeStyle = st.street;
      ctx.lineWidth = Math.max(3, 0.8 * px);
      ctx.stroke(p.paths);
      if (ppm > 0.15) {
        ctx.fillStyle = st.stoneDark;
        ctx.fill(p.graves);
      }
    }

    drawRoads();

    if (!showBuildings) {
      // Blocks read as solid roofscape at this distance
      for (const { w, p } of ready) {
        if (w.type === "park" || w.type === "cemetery") continue;
        ctx.fillStyle = w.type === "wealthy" || w.type === "palace" ? st.wRoofShades[0][1] : st.roofShades[0][1];
        ctx.globalAlpha *= 0.85;
        ctx.fill(p.outline);
        ctx.globalAlpha /= 0.85;
      }
    } else {
      if (st.shadow) {
        ctx.fillStyle = st.shadow;
        for (const { p } of ready) ctx.fill(p.shadow);
      }
      for (const { p } of ready) {
        for (const [paths, cols] of [[p.roofs, st.roofShades], [p.wRoofs, st.wRoofShades]] as const) {
          paths.forEach((byShade, i) => {
            const c = cols[i % cols.length];
            byShade.forEach((pp, k) => {
              ctx.fillStyle = c[k];
              ctx.fill(pp);
            });
          });
        }
        if (st.outline && ppm > 0.12) {
          ctx.strokeStyle = st.outline;
          ctx.lineWidth = 0.7 * px;
          ctx.stroke(p.outline);
        }
      }
      if (ppm > 0.18) {
        const awnings = ["#c0392b", "#e6b84f", "#3d7ab8", "#f2efe6"];
        ready.forEach(({ p }, i) => {
          ctx.fillStyle = awnings[i % awnings.length];
          ctx.fill(p.stalls);
        });
      }
    }

    // Trees
    if (ppm > 0.06 && !(isInteracting && ppm < 0.2)) {
      for (const { p } of ready) {
        if (!p.hasTrees) continue;
        if (theme === "Realistic") {
          ctx.fillStyle = "rgba(20,30,15,0.3)";
          ctx.fill(p.treeShadow);
        }
        ctx.fillStyle = st.treeDark;
        ctx.fill(p.trees);
        if (theme !== "Atlas") {
          ctx.fillStyle = st.tree;
          ctx.fill(p.treeLight);
        }
        if (theme === "Historical") {
          ctx.strokeStyle = st.stoneDark;
          ctx.lineWidth = 0.6 * px;
          ctx.stroke(p.trees);
        }
      }
    }

    for (const { p } of ready) for (const lm of p.landmarks) this.drawLandmark(ctx, lm, st, ppm, px);
    if (ppm > 0.04) {
      for (const { p } of ready) {
        for (let i = 0; i < p.domes.length; i += 3) {
          const x = p.domes[i];
          const y = p.domes[i + 1];
          const rr = p.domes[i + 2];
          const g = ctx.createRadialGradient(x - rr * 0.35, y - rr * 0.35, rr * 0.1, x, y, rr);
          g.addColorStop(0, shade(st.dome, 0.45));
          g.addColorStop(0.6, st.dome);
          g.addColorStop(1, shade(st.dome, -0.35));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = shade(st.dome, -0.5);
          ctx.lineWidth = Math.max(0.4, 0.5 * px);
          ctx.stroke();
        }
        ctx.fillStyle = "#efe8da";
        ctx.fill(p.minarets);
        ctx.strokeStyle = st.stoneDark;
        ctx.lineWidth = Math.max(0.5, 0.6 * px);
        ctx.stroke(p.minarets);
      }
    }
  }

  private drawLandmark(ctx: CanvasRenderingContext2D, lm: Landmark, st: ThemedStyle, ppm: number, px: number) {
    if (lm.kind === "windmill") {
      if (ppm < 0.05) return;
      const [x, y, r] = lm.circles;
      ctx.fillStyle = st.stone;
      ctx.strokeStyle = st.stoneDark;
      ctx.lineWidth = Math.max(0.6, 0.6 * px);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = Math.max(1, 0.7 * px);
      ctx.beginPath();
      ctx.moveTo(x - r * 2.6, y - r * 2.6);
      ctx.lineTo(x + r * 2.6, y + r * 2.6);
      ctx.moveTo(x + r * 2.6, y - r * 2.6);
      ctx.lineTo(x - r * 2.6, y + r * 2.6);
      ctx.stroke();
      return;
    }
    if (lm.kind === "castle") {
      const curtain = path(lm.polys);
      ctx.fillStyle = shade(st.plaza, -0.05);
      ctx.fill(curtain);
      ctx.strokeStyle = st.stoneDark;
      ctx.lineWidth = Math.max(9, 2.5 * px);
      ctx.stroke(curtain);
      ctx.strokeStyle = st.stone;
      ctx.lineWidth = Math.max(6, 1.4 * px);
      ctx.stroke(curtain);
      const t = circles(lm.circles);
      ctx.fillStyle = st.stone;
      ctx.fill(t);
      ctx.lineWidth = Math.max(1.5, 0.8 * px);
      ctx.strokeStyle = st.stoneDark;
      ctx.stroke(t);
      return;
    }
    const body = path(lm.polys);
    const roof = lm.kind === "cathedral" || lm.kind === "church" ? "#6e7884" : lm.kind === "palace" ? "#5f6f86" : "#8a8c8f";
    ctx.fillStyle = lm.kind === "fountain" ? "#7fb2c9" : roof;
    ctx.fill(body);
    if (lm.accents.length) {
      ctx.fillStyle = shade(roof, -0.25);
      ctx.fill(path(lm.accents));
    }
    if (lm.circles.length) {
      const c = circles(lm.circles);
      ctx.fillStyle = lm.kind === "fountain" ? "#7fb2c9" : lm.kind === "lighthouse" ? "#efe9de" : shade(roof, -0.1);
      ctx.fill(c);
      ctx.strokeStyle = st.stoneDark;
      ctx.lineWidth = Math.max(1, 0.7 * px);
      ctx.stroke(c);
    }
    ctx.strokeStyle = st.stoneDark;
    ctx.lineWidth = Math.max(0.8, 0.6 * px);
    ctx.stroke(body);
    if (lm.kind === "lighthouse" && ppm > 0.05) {
      ctx.fillStyle = "rgba(255,230,140,0.9)";
      ctx.beginPath();
      ctx.arc(lm.circles[0], lm.circles[1], 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBoats(ctx: CanvasRenderingContext2D, L: CityLayout, theme: MapTheme) {
    for (const b of L.boats) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      const l = b.len;
      const w = l * 0.32;
      ctx.beginPath();
      ctx.moveTo(-l / 2, -w / 2);
      ctx.lineTo(l * 0.25, -w / 2);
      ctx.quadraticCurveTo(l / 2, 0, l * 0.25, w / 2);
      ctx.lineTo(-l / 2, w / 2);
      ctx.closePath();
      ctx.fillStyle = theme === "Historical" ? "#b08a5e" : "#6b4a2e";
      ctx.fill();
      ctx.strokeStyle = "rgba(30,20,10,0.7)";
      ctx.lineWidth = 0.6;
      ctx.stroke();
      if (b.sail) {
        ctx.fillStyle = "#f3eee2";
        ctx.fillRect(-l * 0.08, -w * 0.9, l * 0.12, w * 1.8);
      }
      ctx.restore();
    }
  }

  private drawStreetLabels(
    ctx: CanvasRenderingContext2D,
    L: CityLayout,
    sx: number,
    sy: number,
    ppm: number,
    theme: MapTheme,
  ) {
    const ct = THEMES[theme];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `500 ${Math.round(Math.min(16, 10 + ppm * 2))}px ${ct.font}`;
    ctx.globalAlpha = Math.min(1, (ppm - 0.22) / 0.15);
    for (const s of L.streetLabels) {
      ctx.save();
      ctx.translate(sx + s.x * ppm, sy + s.y * ppm);
      ctx.rotate(s.angle);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(245,238,220,0.9)";
      ctx.strokeText(s.text, 0, 0);
      ctx.fillStyle = "rgba(60,45,30,0.95)";
      ctx.fillText(s.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawDistrictLabels(
    ctx: CanvasRenderingContext2D,
    L: CityLayout,
    sx: number,
    sy: number,
    ppm: number,
    theme: MapTheme,
  ) {
    const ct = THEMES[theme];
    const fade = Math.min(1, (L.Ru * ppm - 260) / 140);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const taken: [number, number, number, number][] = [];
    const sorted = [...L.labels].sort((a, b) => b.size - a.size);
    for (const lab of sorted) {
      const x = sx + lab.x * ppm;
      const y = sy + lab.y * ppm;
      const size = Math.round(Math.min(18, 10 + lab.size * 1.5));
      ctx.font = `italic 600 ${size}px ${ct.font}`;
      const w = ctx.measureText(lab.text.toUpperCase()).width;
      const box: [number, number, number, number] = [x - w / 2 - 8, y - size, x + w / 2 + 8, y + size];
      if (taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
      taken.push(box);
      ctx.globalAlpha = fade * 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme === "Historical" ? "rgba(240,228,198,0.8)" : "rgba(255,250,240,0.75)";
      ctx.strokeText(lab.text.toUpperCase(), x, y);
      ctx.fillStyle = ct.districtLabel;
      ctx.fillText(lab.text.toUpperCase(), x, y);
    }
    ctx.restore();
  }
}
