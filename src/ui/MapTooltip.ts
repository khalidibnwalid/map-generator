import { WorldData, type City } from "../game/WorldData";
import { nearestPoi, POI_LABELS } from "../game/generators/generatePOIs";
import { RESOURCE_INFO, WEALTH_TIERS } from "../game/generators/generateEconomy";
import { cityExports, cityTrade, tradeRole } from "../game/generators/generateTrade";
import { nationFlagUrl } from "../game/flags";
import { rulerStyle } from "../game/sim/Rulers";
import type { SnapNation } from "../game/sim/History";

// What the map tooltip says about a point: the nearest resource, landmark or
// settlement when zoomed in, else the sea or the realm and its land.

export interface TooltipContent {
  title: string;
  text: string;
  icon?: string;
}

// People per km² for a normalized density value (rural + urban mix)
export function peoplePerKm2(d: number): number {
  return Math.round(2 + Math.pow(Math.max(0, d), 1.6) * 160);
}

export interface PointOptions {
  scale: number; // screen pixels per cell
  resources: boolean; // resource layer shown
  pois: boolean; // landmark layer shown
  diplomacyFocus: number; // pinned realm on the diplomacy map, -1 none
}

// A recorded year of history, as the timeline replays it
export interface ReplayPoint {
  year: number;
  owner: Int16Array;
  nations: SnapNation[];
  world: WorldData;
}

const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

export function describeReplayPoint(world: WorldData, replay: ReplayPoint, fx: number, fy: number): TooltipContent | null {
  const wy = Math.floor(fy);
  const x = ((Math.floor(fx) % world.width) + world.width) % world.width;
  const k = wy >= 0 && wy < world.height && !world.sampler.isWater(fx, fy) ? replay.owner[wy * world.width + x] : -1;
  const s = replay.nations[k];
  if (!s) return null;
  const over = replay.nations.find((o) => o.uid === s.overlord);
  const lines = [`In the year ${replay.year}`];
  if (s.ruler) lines.push(`Ruled by ${s.ruler}`);
  if (over) lines.push(`Vassal of ${over.name}`);
  return { title: s.name, text: lines.join("\n"), icon: nationFlagUrl(replay.world, k, 24, 16) };
}

// The realm whose land is at (fx, fy), or -1
export function realmAt(world: WorldData, fx: number, fy: number): number {
  const wy = Math.floor(fy);
  if (wy < 0 || wy >= world.height || world.sampler.isWater(fx, fy)) return -1;
  const x = ((Math.floor(fx) % world.width) + world.width) % world.width;
  return world.grid[x][wy].nationIndex ?? -1;
}

function describeCity(world: WorldData, city: City): TooltipContent {
  const lines: string[] = [];
  const owner = world.nations[city.nationIndex];
  const kind = city.isCapital ? "♦ Capital" : city.size === 2 ? "● City" : city.size === 1 ? "● Town" : "· Village";
  lines.push(`${kind}${owner ? ` of ${owner.name}` : ""}`);
  lines.push(`Population ${city.population.toLocaleString()}`);
  lines.push(`Area ~${(Math.PI * (city.radiusM / 1000) ** 2).toFixed(1)} km²${city.isPort ? " · Port" : ""}`);
  lines.push("Wealth: " + WEALTH_TIERS[city.wealthTier ?? 2]);
  // e.g. "Trade hub · 3 caravan routes · 1 sea lane", then exports
  const trade = cityTrade(city);
  const tradeBits = [tradeRole(trade, !!city.isPort)];
  if (trade?.caravans) tradeBits.push(plural(trade.caravans, "caravan route"));
  if (trade?.lanes) tradeBits.push(plural(trade.lanes, "sea lane"));
  lines.push(tradeBits.join(" · "));
  if (trade?.cut) lines.push(`War has cut ${plural(trade.cut, "trade route")}`);
  const exports = cityExports(city);
  if (exports.length) lines.push((trade && trade.volume > 0 ? "Exports " : "Produces ") + exports.join(", "));
  const prov = world.provinces[city.provinceIndex ?? -1];
  if (prov) lines.push(`Province: ${prov.name}`);
  return { title: city.name, text: lines.join("\n") };
}

export function describePoint(world: WorldData, fx: number, fy: number, o: PointOptions): TooltipContent | null {
  const wy = Math.floor(fy);
  if (wy < 0 || wy >= world.height) return null;
  const x = ((Math.floor(fx) % world.width) + world.width) % world.width;
  const cell = world.grid[x][wy];
  const onLand = !world.sampler.isWater(fx, fy);
  const hovered = onLand ? (cell.nationIndex ?? -1) : -1;

  if (o.resources && o.scale > 2.8) {
    let best = null;
    let bd = 8 / o.scale;
    for (const r of world.resources) {
      let dx = Math.abs(r.x - fx);
      if (dx > world.width / 2) dx = world.width - dx;
      const d = Math.hypot(dx, r.y - fy);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    if (best) {
      const info = RESOURCE_INFO[best.kind];
      const grade = best.richness > 1.2 ? "Rich" : best.richness > 0.85 ? "Good" : "Modest";
      return { title: info.label, text: `${grade} deposit · trade value ${info.value}/12` };
    }
  }
  if (o.pois && o.scale > 2.6) {
    const poi = nearestPoi(world, fx, fy, 9 / o.scale);
    if (poi) {
      const owner = world.nations[poi.nationIndex];
      return { title: poi.name, text: `${POI_LABELS[poi.kind]}${owner ? ` · ${owner.name}` : ""}` };
    }
  }
  // A nearby settlement takes priority over the land around it
  let nearest: City | null = null;
  let nearestDist = Infinity;
  for (const city of world.cities) {
    let dx = Math.abs(fx - city.x);
    if (dx > world.width / 2) dx = world.width - dx;
    const dist = Math.hypot(dx, fy - city.y);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = city;
    }
  }
  if (nearest && nearestDist < Math.max(10 / o.scale, (nearest.radiusM / 5000) * 1.1)) return describeCity(world, nearest);

  const lines: string[] = [];
  if (!onLand) {
    const owner = world.nations[cell.nationIndex ?? -1];
    const lake = world.waterType[wy * world.width + x] === 2;
    lines.push(owner ? `${lake ? "Internal waters" : "Territorial waters"} of ${owner.name}` : "International waters");
    lines.push(`Depth ~${Math.abs(WorldData.elevationMeters(Math.min(cell.elevation, 0.449))).toLocaleString()} m`);
    return { title: lake ? "Lake" : cell.elevation < 0.3 ? "Open Ocean" : "Sea", text: lines.join("\n") };
  }

  const nation = hovered >= 0 ? world.nations[hovered] : null;
  if (nation) {
    lines.push(`${nation.government ?? "Realm"} of ${nation.name}`);
    const r = nation.ruler;
    if (r) {
      const reign = world.year - r.since;
      lines.push(`${rulerStyle(nation)}${nation.dynasty ? ` · House of ${nation.dynasty}` : ""}`);
      lines.push(`Age ${world.year - r.born} · ${reign < 1 ? "newly crowned" : `${reign} year${reign === 1 ? "" : "s"} on the throne`}`);
    }
    const prov = world.provinces[cell.provinceIndex ?? -1];
    if (prov) lines.push(`Province: ${prov.name}${prov.area ? ` (${prov.area.toLocaleString()} km²)` : ""}`);
    const focus = o.diplomacyFocus;
    if (focus >= 0 && focus !== hovered) lines.push(`Relation with ${world.nations[focus]?.name}: ${world.relations[focus]?.[hovered] ?? "Neutral"}`);
  }
  const culture = world.cultures[cell.cultureIndex ?? -1];
  if (culture) lines.push(`Culture: ${culture.name}`);
  lines.push(`${cell.biome} · ${WorldData.elevationMeters(cell.elevation).toLocaleString()} m · ${WorldData.temperatureC(cell.temperature)}°C`);
  lines.push(`Density ~${peoplePerKm2(cell.populationDensity)} /km²${cell.hasRiver ? " · River" : ""}`);
  if (nation) lines.push(touch() ? "Long press for the fact sheet" : "Alt+click for the fact sheet");
  return { title: nation ? nation.name : "Unclaimed Land", text: lines.join("\n"), icon: nation ? nationFlagUrl(world, hovered, 24, 16) : "" };
}
