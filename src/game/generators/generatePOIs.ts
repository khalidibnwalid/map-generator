import type { GeneratorContext } from "./types";
import type { WorldData } from "../WorldData";
import { roadBridges } from "./generateRoads";
import { sampleCurve } from "../util/curves";
import { yieldFrame } from "../util/grid";

export type PoiKind =
  | "castle"
  | "fort" // border fort / customs post where a road crosses a frontier
  | "watchtower"
  | "ruins"
  | "inn" // waystation along a road
  | "bridge"
  | "dam"
  | "mine"
  | "monastery"
  | "port";

export interface Poi {
  kind: PoiKind;
  x: number; // world cells
  y: number;
  angle: number; // orientation (road / river direction)
  name: string;
  nationIndex: number;
}

export const POI_LABELS: Record<PoiKind, string> = {
  castle: "Castle",
  fort: "Border Fort",
  watchtower: "Watchtower",
  ruins: "Ruins",
  inn: "Waystation",
  bridge: "Bridge",
  dam: "Dam",
  mine: "Mine",
  monastery: "Zawiya (Sufi lodge)",
  port: "Port",
};

// Small features scattered across the world: castles on hills, ruins, inns
// along roads, forts where roads cross borders, bridges, dams, mines, ports...
export async function generatePOIs(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width: W, height: H, onProgress } = ctx;
  const resScale = W / 800;
  const pois: Poi[] = [];
  const rand = noise.random;

  const nameFor = (x: number, y: number) => {
    const cell = world.getCell(x, y);
    const lang = world.languages[cell?.cultureIndex ?? 0];
    return lang ? lang.word() : "Old";
  };
  const nationAt = (x: number, y: number) => world.getCell(x, y)?.nationIndex ?? -1;

  // Spacing check against cities and previously placed POIs
  const clearOf = (x: number, y: number, cityR: number, poiR: number) => {
    for (const c of world.cities) {
      let dx = Math.abs(c.x - x);
      if (dx > W / 2) dx = W - dx;
      if (Math.hypot(dx, c.y - y) < cityR) return false;
    }
    for (const p of pois) {
      let dx = Math.abs(p.x - x);
      if (dx > W / 2) dx = W - dx;
      if (Math.hypot(dx, p.y - y) < poiR) return false;
    }
    return true;
  };
  const add = (kind: PoiKind, x: number, y: number, angle: number, name: string) =>
    pois.push({ kind, x, y, angle, name, nationIndex: nationAt(x, y) });

  // --- Along roads: border forts, waystations ---
  for (const road of world.worldRoads) {
    const pts: { x: number; y: number }[] = [];
    sampleCurve(road.points, road.points.map(() => 0), 0.5, (x, y) => pts.push({ x, y }));
    let lastNation = nationAt(pts[0].x, pts[0].y);
    let since = 0;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[i - 1];
      since += Math.hypot(p.x - q.x, p.y - q.y);
      const ang = Math.atan2(p.y - q.y, p.x - q.x);
      const n = nationAt(p.x, p.y);
      if (n !== lastNation && n >= 0 && lastNation >= 0) {
        if (clearOf(p.x, p.y, 2, 3 * resScale)) add("fort", p.x, p.y, ang, `${nameFor(p.x, p.y)} Gate`);
      }
      lastNation = n;
      if (since > 14 * resScale && road.tier >= 1 && clearOf(p.x, p.y, 4 * resScale, 6 * resScale)) {
        add("inn", p.x + Math.cos(ang + 1.57) * 0.02, p.y + Math.sin(ang + 1.57) * 0.02, ang, `${nameFor(p.x, p.y)} Inn`);
        since = 0;
      }
    }
  }
  onProgress?.(30);
  await yieldFrame();

  // --- Bridges where roads cross rivers ---
  for (const b of roadBridges(world)) {
    // Orient across the nearest river point's direction
    let best = Infinity;
    let ang = 0;
    let bx = b.x;
    let by = b.y;
    for (const r of world.rivers) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const p = r.points[i];
        let dx = p.x - b.x;
        if (Math.abs(dx) > 3) {
          dx = ((dx % W) + W + W / 2) % W - W / 2;
          if (Math.abs(dx) > 3) continue;
        }
        const d = Math.hypot(dx, p.y - b.y);
        if (d < best) {
          best = d;
          const q = r.points[i + 1];
          ang = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2;
          bx = b.x + dx;
          by = p.y;
        }
      }
    }
    if (best < 1.5 && clearOf(bx, by, 0.6, 1.2)) add("bridge", bx, by, ang, `${nameFor(bx, by)} Bridge`);
  }
  onProgress?.(55);
  await yieldFrame();

  // --- Dams at some lake outlets near towns ---
  for (const r of world.rivers) {
    const s = r.points[0];
    let nearLake = false;
    for (let dy = -1; dy <= 1 && !nearLake; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const c = world.getCell(s.x + dx, s.y + dy);
        if (c && c.biome === "Lake") nearLake = true;
      }
    if (!nearLake || rand() > 0.45 || r.points.length < 4) continue;
    const q = r.points[2];
    if (!clearOf(q.x, q.y, 1, 3)) continue;
    add("dam", q.x, q.y, Math.atan2(q.y - s.y, q.x - s.x) + Math.PI / 2, `${nameFor(q.x, q.y)} Dam`);
  }

  // --- Terrain features: castles, watchtowers, mines, monasteries, ruins ---
  const nNations = world.nations.length;
  const tries = Math.round(W * H * 0.02);
  const counts = { castle: 0, watchtower: 0, mine: 0, monastery: 0, ruins: 0 };
  const quota = {
    castle: Math.round(nNations * 1.8),
    watchtower: Math.round(nNations * 2.2),
    mine: Math.round(nNations * 1.2),
    monastery: Math.round(nNations * 0.8),
    ruins: Math.round(nNations * 1.5),
  };
  for (let t = 0; t < tries; t++) {
    const x = Math.floor(rand() * W) + 0.5;
    const y = Math.floor(rand() * H) + 0.5;
    const cell = world.getCell(x, y);
    if (!cell || cell.isWater) continue;
    const e = cell.elevation;
    const forest = cell.biome.includes("Forest") || cell.biome === "Taiga";
    if (e > 0.62 && e < 0.8 && counts.castle < quota.castle && clearOf(x, y, 4 * resScale, 8 * resScale)) {
      counts.castle++;
      add("castle", x, y, rand() * Math.PI, `${nameFor(x, y)} Castle`);
    } else if (cell.isNationBorder && counts.watchtower < quota.watchtower && clearOf(x, y, 3 * resScale, 6 * resScale)) {
      counts.watchtower++;
      add("watchtower", x, y, 0, `${nameFor(x, y)} Watch`);
    } else if (e > 0.72 && counts.mine < quota.mine && clearOf(x, y, 3 * resScale, 6 * resScale)) {
      counts.mine++;
      add("mine", x, y, rand() * Math.PI, `${nameFor(x, y)} Mine`);
    } else if (forest && e > 0.55 && counts.monastery < quota.monastery && clearOf(x, y, 6 * resScale, 10 * resScale)) {
      counts.monastery++;
      add("monastery", x, y, rand() * Math.PI, `Zawiya of ${nameFor(x, y)}`);
    } else if (counts.ruins < quota.ruins && rand() < 0.15 && clearOf(x, y, 5 * resScale, 8 * resScale)) {
      counts.ruins++;
      add("ruins", x, y, rand() * Math.PI, `Ruins of ${nameFor(x, y)}`);
    }
  }

  // --- Ports: towns and cities by the sea ---
  for (const c of world.cities) {
    if (!c.isPort || (c.size < 1 && !c.isCapital)) continue;
    // Point toward the sea
    let best = 0;
    let bestA = 0;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const v = -world.sampler.coastField(c.x + Math.cos(ang) * 0.5, c.y + Math.sin(ang) * 0.5, 4);
      if (v > best) {
        best = v;
        bestA = ang;
      }
    }
    if (best <= 0) continue;
    pois.push({ kind: "port", x: c.x, y: c.y, angle: bestA, name: `Port of ${c.name}`, nationIndex: c.nationIndex });
  }

  world.pois = pois;
  onProgress?.(100);
}

export function nearestPoi(world: WorldData, x: number, y: number, maxDist: number): Poi | null {
  let best: Poi | null = null;
  let bestD = maxDist;
  for (const p of world.pois) {
    let dx = Math.abs(p.x - x);
    if (dx > world.width / 2) dx = world.width - dx;
    const d = Math.hypot(dx, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
