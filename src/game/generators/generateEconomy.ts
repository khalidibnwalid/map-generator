import type { GeneratorContext } from "./types";
import type { City, WorldData } from "../WorldData";
import { finalizeCity } from "./generateCities";
import { decodeSdf } from "../../core/FieldNoise";
import { yieldFrame } from "../util/grid";

export type ResourceKind =
  | "gold" | "gems" | "silver" | "iron" | "copper" | "coal" | "marble" | "salt"
  | "spices" | "silk" | "incense" | "ivory" | "furs" | "timber" | "fish"
  | "pearls" | "amber" | "wine" | "horses" | "grain" | "dyes";

export interface Resource {
  kind: ResourceKind;
  x: number;
  y: number;
  richness: number; // 0.5 .. 1.5
}

export const RESOURCE_INFO: Record<ResourceKind, { label: string; value: number; color: string; glyph: string }> = {
  gold: { label: "Gold", value: 10, color: "#e8c547", glyph: "Au" },
  gems: { label: "Gemstones", value: 12, color: "#5fd3e6", glyph: "◆" },
  silver: { label: "Silver", value: 7, color: "#c9ced6", glyph: "Ag" },
  iron: { label: "Iron", value: 4, color: "#8a7f78", glyph: "Fe" },
  copper: { label: "Copper", value: 4, color: "#c97b4a", glyph: "Cu" },
  coal: { label: "Coal", value: 3, color: "#3b3b3b", glyph: "C" },
  marble: { label: "Marble", value: 5, color: "#ece8e1", glyph: "M" },
  salt: { label: "Salt", value: 3, color: "#f4f1ea", glyph: "S" },
  spices: { label: "Spices", value: 8, color: "#d9662b", glyph: "Sp" },
  silk: { label: "Silk", value: 8, color: "#d56fa8", glyph: "Si" },
  incense: { label: "Incense", value: 7, color: "#b98e5a", glyph: "In" },
  ivory: { label: "Ivory", value: 7, color: "#f2e7cf", glyph: "Iv" },
  furs: { label: "Furs", value: 5, color: "#7b5a3d", glyph: "Fu" },
  timber: { label: "Timber", value: 2, color: "#5b8a3c", glyph: "T" },
  fish: { label: "Fisheries", value: 2, color: "#4f8fc0", glyph: "F" },
  pearls: { label: "Pearls", value: 9, color: "#f3eef8", glyph: "P" },
  amber: { label: "Amber", value: 6, color: "#e39a2c", glyph: "Am" },
  wine: { label: "Wine", value: 5, color: "#8e2b4b", glyph: "W" },
  horses: { label: "Horses", value: 4, color: "#a5703f", glyph: "H" },
  grain: { label: "Grain", value: 2, color: "#d8c25a", glyph: "G" },
  dyes: { label: "Dyes", value: 6, color: "#6a4bb5", glyph: "D" },
};

export const WEALTH_TIERS = ["Destitute", "Poor", "Modest", "Prosperous", "Rich", "Opulent"];

// Which resource (if any) a cell could host, with a base chance.
function candidateFor(world: WorldData, x: number, y: number, rand: () => number): ResourceKind | null {
  const cell = world.grid[x][y];
  const b = cell.biome;
  const e = cell.elevation;
  const i = y * world.width + x;
  const coast = !cell.isWater && decodeSdf(world.coastSdf[i]) < 1.2;
  const r = rand();
  if (e > 0.7 && cell.distanceToBoundary < 6) {
    if (r < 0.18) return "gold";
    if (r < 0.3) return "gems";
    if (r < 0.5) return "silver";
  }
  if (e > 0.6 && e < 0.82) {
    if (r < 0.35) return "iron";
    if (r < 0.6) return "copper";
    if (r < 0.75 && cell.temperature > 0.35) return "marble";
  }
  if (coast) {
    if (cell.temperature > 0.7 && r < 0.25) return "pearls";
    if (cell.temperature < 0.35 && r < 0.2) return "amber";
    if (r < 0.45) return "fish";
  }
  switch (b) {
    case "Salt Flat":
    case "Subtropical Desert":
    case "Cold Desert":
      return r < 0.5 ? "salt" : b === "Subtropical Desert" ? "incense" : null;
    case "Sand Dunes":
    case "Mediterranean Scrub":
      return r < 0.4 ? "incense" : r < 0.7 ? "wine" : null;
    case "Tropical Rain Forest":
    case "Cloud Forest":
      return r < 0.45 ? "spices" : r < 0.7 ? "dyes" : "timber";
    case "Tropical Seasonal Forest":
      return r < 0.35 ? "silk" : r < 0.6 ? "spices" : "timber";
    case "Savanna":
      return r < 0.45 ? "ivory" : "grain";
    case "Taiga":
    case "Tundra":
      return r < 0.6 ? "furs" : "timber";
    case "Temperate Deciduous Forest":
    case "Temperate Rain Forest":
    case "Montane Forest":
      return r < 0.25 ? "coal" : "timber";
    case "Steppe":
    case "Prairie":
      return r < 0.6 ? "horses" : "grain";
    case "Grassland":
    case "Floodplain":
      return r < 0.7 ? "grain" : r < 0.85 ? "wine" : "horses";
    default:
      return null;
  }
}

// Places resources, then scores every settlement (fertility, harbor, river,
// centrality, nearby wealth) and re-tiers them into cities / towns / villages.
export async function generateEconomy(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width: W, height: H, onProgress } = ctx;
  const rand = noise.random;
  const resScale = W / 800;
  const resources: Resource[] = [];
  const spacing = 5 * resScale;
  const occupied = new Set<number>();
  const bucket = (x: number, y: number) => Math.floor(y / spacing) * 10000 + Math.floor(x / spacing);
  const tries = Math.round(W * H * 0.012);
  for (let t = 0; t < tries; t++) {
    const x = Math.floor(rand() * W);
    const y = Math.floor(rand() * H);
    const cell = world.grid[x][y];
    if (cell.isWater) continue;
    const k = bucket(x, y);
    if (occupied.has(k)) continue;
    const kind = candidateFor(world, x, y, rand);
    if (!kind) continue;
    // Precious finds are rare
    const v = RESOURCE_INFO[kind].value;
    if (rand() > 1.6 / Math.sqrt(v)) continue;
    occupied.add(k);
    resources.push({ kind, x: x + 0.5, y: y + 0.5, richness: 0.5 + rand() });
  }
  world.resources = resources;
  onProgress?.(40);
  await yieldFrame();

  // Spatial bins for resources and settlements
  const B = 16;
  const BX = Math.ceil(W / B);
  const bins = new Map<number, Resource[]>();
  for (const r of resources) {
    const key = Math.floor(r.y / B) * BX + Math.floor(r.x / B);
    const l = bins.get(key) ?? [];
    l.push(r);
    bins.set(key, l);
  }
  const cityBins = new Map<number, City[]>();
  for (const c of world.cities) {
    const key = Math.floor(c.y / B) * BX + (Math.floor(c.x / B) % BX);
    const l = cityBins.get(key) ?? [];
    l.push(c);
    cityBins.set(key, l);
  }
  const around = <T extends { x: number; y: number }>(m: Map<number, T[]>, x: number, y: number, r: number, fn: (o: T, d: number) => void) => {
    const reach = Math.ceil(r / B);
    const bx = Math.floor(x / B);
    const by = Math.floor(y / B);
    for (let oy = -reach; oy <= reach; oy++)
      for (let ox = -reach; ox <= reach; ox++) {
        const key = (by + oy) * BX + (((bx + ox) % BX) + BX) % BX;
        for (const o of m.get(key) ?? []) {
          let dx = Math.abs(o.x - x);
          if (dx > W / 2) dx = W - dx;
          const d = Math.hypot(dx, o.y - y);
          if (d <= r) fn(o, d);
        }
      }
  };

  const scores = new Map<City, number>();
  for (const c of world.cities) {
    const cell = world.getCell(c.x, c.y);
    let s = (cell?.populationDensity ?? 0) * 3;
    if (c.isPort) s += 1.2;
    if (cell?.hasRiver) s += 0.8;
    let neighbors = 0;
    around(cityBins, c.x, c.y, 15 * resScale, () => neighbors++);
    s += Math.min(1.5, neighbors * 0.08); // market town for its hinterland
    let wealth = 0;
    const local: string[] = [];
    around(bins, c.x, c.y, 14 * resScale, (r, d) => {
      const v = RESOURCE_INFO[r.kind].value * r.richness;
      wealth += v / (1 + d / (4 * resScale));
      if (d < 8 * resScale && !local.includes(r.kind)) local.push(r.kind);
    });
    s += Math.min(2, wealth * 0.06);
    if (c.isCapital) s += 3;
    s += rand() * 0.6; // history is not deterministic
    scores.set(c, s);
    c.wealth = c.baseWealth = wealth + (c.isPort ? 6 : 0) + (cell?.hasRiver ? 3 : 0);
    c.resources = local.slice(0, 3);
  }
  onProgress?.(70);
  await yieldFrame();

  // Re-tier: top ~4% cities, next ~10% towns, the rest villages
  const ranked = [...world.cities].sort((a, b) => scores.get(b)! - scores.get(a)!);
  const nCity = Math.max(world.nations.length, Math.round(ranked.length * 0.04));
  const nTown = Math.round(ranked.length * 0.1);
  ranked.forEach((c, i) => {
    const size = c.isCapital || i < nCity ? 2 : i < nCity + nTown ? 1 : 0;
    c.size = size;
    const cell = world.getCell(c.x, c.y);
    const dens = Math.min(1, (cell?.populationDensity ?? 0.2) * 0.6 + (scores.get(c)! / 8) * 0.6);
    finalizeCity(world, c, size === 0 ? dens * 0.8 : dens);
  });

  assignWealthTiers(world);
  onProgress?.(100);
}

// Wealth tier per settlement, relative to the rest of the world
export function assignWealthTiers(world: WorldData) {
  const ws = world.cities.map((c) => c.wealth ?? 0).sort((a, b) => a - b);
  const q = (p: number) => ws[Math.floor((ws.length - 1) * p)] ?? 0;
  const cuts = [q(0.1), q(0.3), q(0.6), q(0.85), q(0.97)];
  for (const c of world.cities) {
    const w = (c.wealth ?? 0) * (1 + (c.size === 2 ? 0.6 : c.size === 1 ? 0.25 : 0));
    let t = 0;
    while (t < cuts.length && w > cuts[t]) t++;
    c.wealthTier = t;
  }
}

// Resource wealth and notable resources around a spot, for settlements
// founded after generation (same weighting as above)
export function localWealth(world: WorldData, x: number, y: number): { wealth: number; kinds: string[] } {
  const resScale = world.width / 800;
  const W = world.width;
  let wealth = 0;
  const kinds: string[] = [];
  for (const r of world.resources) {
    let dx = Math.abs(r.x - x);
    if (dx > W / 2) dx = W - dx;
    const d = Math.hypot(dx, r.y - y);
    if (d > 14 * resScale) continue;
    wealth += (RESOURCE_INFO[r.kind].value * r.richness) / (1 + d / (4 * resScale));
    if (d < 8 * resScale && kinds.length < 3 && !kinds.includes(r.kind)) kinds.push(r.kind);
  }
  return { wealth, kinds };
}
