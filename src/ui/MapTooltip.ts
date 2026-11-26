import { WorldData, type City } from "../game/WorldData";
import { nearestPoi, POI_LABELS } from "../game/generators/generatePOIs";
import { RESOURCE_INFO, WEALTH_TIERS } from "../game/generators/generateEconomy";
import { cityExports, cityTrade, tradeRole } from "../game/generators/generateTrade";
import { flagUrl, nationFlagUrl } from "../game/flags";
import { rulerStyle } from "../game/sim/Rulers";
import { coalitionFlag, coalitionsOf } from "../game/coalitions";
import type { SnapNation } from "../game/sim/History";
import type { ThematicMode } from "../core/GPURenderer";
import { culturesOf, racesOf } from "../game/peoples";
import { provinceTypeInfo } from "../game/provinceTypes";

// What the map tooltip says about a point: the nearest resource, landmark or
// settlement when zoomed in, else the sea or the realm and its land.

export interface TooltipContent {
  title: string;
  text: string;
  icon?: string;
  badges?: { icon: string; text: string }[]; // flagged lines under the text (a realm's coalitions)
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
  layers?: { base: ThematicMode; overlay: ThematicMode }; // with an overlay, the tooltip names both layers' values
}

// Each province's settlement wealth per unit of land (the wealth map's measure)
export function provinceWealthDensity(world: WorldData): number[] {
  const pw = new Float32Array(world.provinces.length);
  for (const c of world.cities) if ((c.provinceIndex ?? -1) >= 0) pw[c.provinceIndex!] += (c.wealth ?? 0) * (1 + c.size);
  return world.provinces.map((p, i) => pw[i] / Math.max(1, (p.area ?? 25) / 25));
}

const WEALTH_WORDS = ["Poorest", "Poor", "Average", "Rich", "Richest"];

// "Culture: Svetaguard", "Culture: Svetaguard & Orvani (mixed)" or "Culture: Uninhabited"
function peoplesLine(world: WorldData, cell: WorldData["grid"][number][number], races: boolean): string | null {
  if (cell.isWater) return null;
  const list = (races ? racesOf(cell) : culturesOf(cell)).map((i) => (races ? world.races[i] : world.cultures[i])?.name).filter(Boolean);
  const label = races ? "Race" : "Culture";
  if (!list.length) return `${label}: Uninhabited`;
  return list.length > 1 ? `${label}: ${list.join(" & ")} (mixed)` : `${label}: ${list[0]}`;
}

// What a thematic layer shows at a land cell, e.g. "Culture: Svetaguard"
function layerValue(world: WorldData, x: number, y: number, nation: number, mode: ThematicMode, focus: number): string | null {
  const cell = world.grid[x][y];
  if (mode === "cultures" || mode === "races") return peoplesLine(world, cell, mode === "races");
  if (nation < 0) return null;
  if (mode === "none") return `Realm: ${world.nations[nation].name}`;
  if (mode === "coalitions") {
    const list = coalitionsOf(world, nation);
    return `Coalition: ${list.length ? list.map((u) => u.name).join(", ") : "none"}`;
  }
  if (mode === "diplomacy") {
    if (focus < 0) return null;
    return focus === nation ? "Diplomacy: focus realm" : `Relation: ${world.relations[focus]?.[nation] ?? "Neutral"}`;
  }
  if (mode === "wealth") {
    const p = cell.provinceIndex ?? -1;
    if (p < 0) return null;
    const dens = provinceWealthDensity(world);
    const below = dens.filter((d) => d < dens[p]).length / Math.max(1, dens.length - 1);
    return `Wealth: ${WEALTH_WORDS[Math.min(4, Math.floor(below * 5))]}`;
  }
  return null;
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
  if (city.formerName) lines.push(`Formerly ${city.formerName}`);
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
  if (prov) lines.push(`${provinceTypeInfo(prov).label}: ${prov.name}`);
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
      const built = poi.year !== undefined ? `\n${poi.kind === "wonder" ? "Raised" : "Founded"} in year ${poi.year}` : "";
      return { title: poi.name, text: `${POI_LABELS[poi.kind]}${owner ? ` · ${owner.name}` : ""}${built}` };
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
    // Learning gathered by its libraries and universities, and shared by neighbors (0.3+ history)
    const k = nation.knowledge ?? 0;
    if (k >= 0.5) lines.push(`Knowledge ${k < 10 ? k.toFixed(1) : Math.round(k)} · armies +${Math.round(Math.min(35, (k / 250) * 100))}%`);
    const prov = world.provinces[cell.provinceIndex ?? -1];
    // "Autonomous region: Vel Harrow (2,350 km²)"; ordinary ones read "Province: ..."
    if (prov) lines.push(`${provinceTypeInfo(prov).label}: ${prov.name}${prov.area ? ` (${prov.area.toLocaleString()} km²)` : ""}`);
    const focus = o.diplomacyFocus;
    if (focus >= 0 && focus !== hovered) lines.push(`Relation with ${world.nations[focus]?.name}: ${world.relations[focus]?.[hovered] ?? "Neutral"}`);
  }
  const both = o.layers && o.layers.overlay !== "none" ? [o.layers.base, o.layers.overlay] : null;
  const values = both?.map((m) => layerValue(world, x, wy, hovered, m, o.diplomacyFocus)).filter((v): v is string => !!v) ?? [];
  if (values.length) lines.push(values.join(" · ")); // base · overlay, e.g. "Culture: X · Race: Y"
  const culture = peoplesLine(world, cell, false);
  if (culture && !both?.includes("cultures")) lines.push(culture);
  const race = !both && o.layers?.base === "races" ? peoplesLine(world, cell, true) : null;
  if (race) lines.push(race);
  lines.push(`${cell.biome} · ${WorldData.elevationMeters(cell.elevation).toLocaleString()} m · ${WorldData.temperatureC(cell.temperature)}°C`);
  lines.push(`Density ~${peoplePerKm2(cell.populationDensity)} /km²${cell.hasRiver ? " · River" : ""}`);
  if (nation) lines.push(touch() ? "Long press for the fact sheet" : "Alt+click for the fact sheet");
  const badges = nation ? coalitionsOf(world, hovered).map((u) => ({ icon: flagUrl(coalitionFlag(world, u), 18, 12), text: u.name })) : [];
  return { title: nation ? nation.name : "Unclaimed Land", text: lines.join("\n"), icon: nation ? nationFlagUrl(world, hovered, 24, 16) : "", badges };
}
