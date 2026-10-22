import type { GeneratorContext } from "./types";
import type { City, Province, WorldData } from "../WorldData";
import { CELL_KM2 } from "../WorldData";
import type { NoiseEngine } from "../../core/NoiseEngine";
import { buildCostField, growRegionsSparse, warpOwners, type CostField } from "../util/regionGrow";
import { yieldFrame } from "../util/grid";

// Land area (cells) of a typical province; densely settled land gets smaller
// provinces, wilderness bigger ones.
const BASE_PROVINCE_CELLS = 900;

interface Seat {
  x: number;
  y: number;
  cityId: number;
}

function provinceName(world: WorldData, city: City | undefined, cells: number[], rand: () => number): string {
  const W = world.width;
  let coast = 0;
  let high = 0;
  let river = 0;
  let border = 0;
  for (const c of cells) {
    const x = c % W;
    const y = (c - x) / W;
    const cell = world.grid[x][y];
    if (cell.elevation > 0.72) high++;
    if (cell.hasRiver) river++;
    if (cell.isNationBorder) border++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = world.getCell(x + dx, y + dy);
      if (n && n.isWater) {
        coast++;
        break;
      }
    }
  }
  const n = cells.length || 1;
  const base = city
    ? city.name
    : world.languages[world.grid[cells[0] % W][Math.floor(cells[0] / W)].cultureIndex ?? 0]?.word() ?? "Wild";
  const r = rand();
  if (high / n > 0.3) return r < 0.5 ? `${base} Highlands` : `Mountains of ${base}`;
  if (border / n > 0.12 && r < 0.6) return `${base} March`;
  if (coast / n > 0.25) return r < 0.5 ? `${base} Coast` : `Shores of ${base}`;
  if (river / n > 0.08 && r < 0.5) return `${base} Vale`;
  const forms = [`${base}shire`, `County of ${base}`, `${base} Province`, `Duchy of ${base}`, `${base}land`];
  return forms[Math.floor(rand() * forms.length)];
}

function tint(hex: string, amt: number): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s: number) =>
    Math.max(0, Math.min(255, Math.round(((v >> s) & 255) * (1 + amt))))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const fields = new WeakMap<WorldData, CostField>();
function provinceField(world: WorldData, noise: NoiseEngine): CostField {
  let f = fields.get(world);
  if (!f) {
    f = buildCostField(world, noise, {
      mountainCost: 3,
      slopeCost: 2,
      riverCost: 2.5,
      noiseAmp: 0.3,
      noiseScale: 0.05,
      noiseOffset: 900,
    });
    fields.set(world, f);
  }
  return f;
}

// Partitions one nation's land between the given seats. Returns per-seat cell lists.
function growNation(
  world: WorldData,
  noise: NoiseEngine,
  nationId: number,
  seats: Seat[],
): number[][] {
  const W = world.width;
  const lists: number[][] = seats.map(() => []);
  growRegionsSparse(
    world,
    provinceField(world, noise),
    seats.map((s) => ({
      cell: Math.floor(s.y) * W + (((Math.floor(s.x) % W) + W) % W),
    })),
    (c, o) => lists[o].push(c),
    (c) => {
      if (world.waterType[c] !== 0) return false;
      const x = c % W;
      return world.grid[x][(c - x) / W].nationIndex === nationId;
    },
  );
  return lists;
}

// Rebuilds all provinces of one nation from scratch (also used by the editor
// when a province is added). Existing provinces of other nations are untouched.
export function partitionNation(
  world: WorldData,
  noise: NoiseEngine,
  nationId: number,
  extraSeats: Seat[] = [],
  keepExistingSeats = false,
  nationLand?: number[],
) {
  const W = world.width;
  const H = world.height;
  const resScale = W / 800;
  const nationCities = world.cities
    .filter((c) => c.nationIndex === nationId)
    .sort((a, b) => b.population - a.population);

  let landCells = nationLand;
  if (!landCells) {
    landCells = [];
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (!cell.isWater && cell.nationIndex === nationId) landCells.push(y * W + x);
      }
  }
  if (landCells.length === 0) return;

  let seats: Seat[] = [];
  if (keepExistingSeats) {
    for (const p of world.provinces)
      if (p.nationIndex === nationId && p.seatX !== undefined && p.seatY !== undefined)
        seats.push({ x: p.seatX, y: p.seatY, cityId: p.capitalCityId });
  } else {
    // Province count grows sub-linearly with the realm: small nations still get
    // several provinces, large ones don't explode into dozens of tiny ones
    const k = landCells.length / (BASE_PROVINCE_CELLS * resScale * resScale);
    const minCells = 25 * resScale * resScale;
    const target = Math.max(
      1,
      Math.min(Math.floor(landCells.length / minCells), Math.max(3, Math.round(k * 0.55 + 2 * Math.sqrt(k)))),
    );
    const baseSpacing = Math.sqrt(landCells.length / target) * 0.8;
    for (const city of nationCities) {
      if (seats.length >= target * 1.3) break;
      const cell = world.getCell(city.x, city.y);
      // Dense regions pack seats tighter
      const spacing = baseSpacing * (1.25 - 0.6 * (cell?.populationDensity ?? 0));
      const ok = seats.every((s) => {
        let dx = Math.abs(s.x - city.x);
        if (dx > W / 2) dx = W - dx;
        return Math.hypot(dx, s.y - city.y) >= spacing;
      });
      if (ok || seats.length === 0) seats.push({ x: city.x, y: city.y, cityId: city.id });
    }
    // Too few towns: seat the remaining provinces on the land farthest from
    // existing seats (sampled to stay cheap)
    const sample = Math.min(landCells.length, 600);
    while (seats.length < target) {
      let best = -1;
      let bestD = -1;
      for (let s = 0; s < sample; s++) {
        const c = landCells[Math.floor((s * landCells.length) / sample)];
        const cx = (c % W) + 0.5;
        const cy = Math.floor(c / W) + 0.5;
        let d = Infinity;
        for (const st of seats) {
          let dx = Math.abs(st.x - cx);
          if (dx > W / 2) dx = W - dx;
          d = Math.min(d, Math.hypot(dx, st.y - cy));
        }
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best < 0 || bestD < baseSpacing * 0.5) break;
      seats.push({ x: (best % W) + 0.5, y: Math.floor(best / W) + 0.5, cityId: -1 });
    }
  }
  seats.push(...extraSeats);

  let lists = growNation(world, noise, nationId, seats);

  // Disconnected nation land (islands, exclaves) becomes its own province if
  // big enough, otherwise joins the nearest province. Everything here works on
  // maps local to this nation's cells to stay cheap on huge worlds.
  const ownerOf = new Map<number, number>();
  lists.forEach((l, i) => l.forEach((c) => ownerOf.set(c, i)));
  const unclaimed = new Set<number>();
  for (const c of landCells) if (!ownerOf.has(c)) unclaimed.add(c);
  const neighbors4 = (c: number): number[] => {
    const x = c % W;
    const y = (c - x) / W;
    const out = [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W)];
    if (y > 0) out.push(c - W);
    if (y < H - 1) out.push(c + W);
    return out;
  };
  if (unclaimed.size > 0) {
    const minIsland = 60 * resScale * resScale;
    const seen = new Set<number>();
    for (const start of unclaimed) {
      if (seen.has(start)) continue;
      const cells: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        for (const n of neighbors4(c))
          if (unclaimed.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
      }
      const members = new Set(cells);
      let idx: number;
      if (cells.length >= minIsland) {
        const inIsland = nationCities.find((ct) =>
          members.has(Math.floor(ct.y) * W + (Math.floor(ct.x) % W)),
        );
        const c0 = cells[Math.floor(cells.length / 2)];
        seats.push(
          inIsland
            ? { x: inIsland.x, y: inIsland.y, cityId: inIsland.id }
            : { x: (c0 % W) + 0.5, y: Math.floor(c0 / W) + 0.5, cityId: -1 },
        );
        lists.push(cells);
        idx = lists.length - 1;
      } else {
        // Attach to the province whose seat is nearest
        const c0 = cells[0];
        const x0 = c0 % W;
        const y0 = (c0 - x0) / W;
        idx = 0;
        let bestD = Infinity;
        seats.forEach((s, i) => {
          let dx = Math.abs(s.x - x0);
          if (dx > W / 2) dx = W - dx;
          const d = Math.hypot(dx, s.y - y0);
          if (d < bestD && i < lists.length) {
            bestD = d;
            idx = i;
          }
        });
        lists[idx].push(...cells);
      }
      for (const c of cells) ownerOf.set(c, idx);
    }
  }

  // Organic wobble on province borders (stays inside the nation)
  {
    const moves = warpOwners(world, noise, landCells, (c) => ownerOf.get(c) ?? -1, 2.5 * resScale);
    const moved = new Map<number, number>();
    for (const [c, o] of moves) if (ownerOf.get(c) !== o) moved.set(c, o);
    if (moved.size > 0) {
      for (const [c, o] of moved) ownerOf.set(c, o);
      lists = lists.map(() => []);
      for (const c of landCells) {
        const o = ownerOf.get(c);
        if (o !== undefined && o >= 0) lists[o].push(c);
      }
    }
  }

  // Merge slivers into the province they border most
  const avg = landCells.length / Math.max(1, lists.length);
  for (let i = 0; i < lists.length; i++) {
    if (lists[i].length === 0 || lists[i].length >= avg * 0.18 || lists.length <= 1) continue;
    const contact = new Map<number, number>();
    for (const c of lists[i]) {
      for (const n of neighbors4(c)) {
        const o = ownerOf.get(n) ?? -1;
        if (o >= 0 && o !== i && lists[o].length > 0) contact.set(o, (contact.get(o) ?? 0) + 1);
      }
    }
    let target = -1;
    let most = 0;
    contact.forEach((v, k) => {
      if (v > most) {
        most = v;
        target = k;
      }
    });
    if (target >= 0) {
      for (const c of lists[i]) ownerOf.set(c, target);
      lists[target].push(...lists[i]);
      lists[i] = [];
    }
  }
  const keep = lists.map((l, i) => ({ l, s: seats[i] })).filter((e) => e.l.length > 0 && e.s);
  lists = keep.map((e) => e.l);
  seats = keep.map((e) => e.s);

  // Replace this nation's provinces, keeping names/colors of surviving seats
  const nation = world.nations[nationId];
  const previous = new Map<string, Province>();
  for (const p of world.provinces)
    if (p.nationIndex === nationId && p.seatX !== undefined) previous.set(`${p.seatX},${p.seatY}`, p);
  const removed = new Set(world.provinces.filter((p) => p.nationIndex === nationId).map((p) => p.id));
  const others = world.provinces.filter((p) => p.nationIndex !== nationId);
  const remap = new Map<number, number>();
  others.forEach((p, i) => {
    remap.set(p.id, i);
    p.id = i;
  });
  if (removed.size > 0 || remap.size !== world.provinces.length) {
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell.provinceIndex === undefined || cell.provinceIndex < 0) continue;
        if (removed.has(cell.provinceIndex)) cell.provinceIndex = -1;
        else cell.provinceIndex = remap.get(cell.provinceIndex) ?? -1;
      }
    for (const c of world.cities)
      if (c.provinceIndex !== undefined && c.provinceIndex >= 0)
        c.provinceIndex = removed.has(c.provinceIndex) ? -1 : remap.get(c.provinceIndex) ?? -1;
  }
  world.provinces = others;

  lists.forEach((cells, i) => {
    const id = world.provinces.length;
    let sumSin = 0;
    let sumCos = 0;
    let sumY = 0;
    let rural = 0;
    for (const c of cells) {
      const x = c % W;
      const y = (c - x) / W;
      world.grid[x][y].provinceIndex = id;
      const a = ((x + 0.5) / W) * Math.PI * 2;
      sumSin += Math.sin(a);
      sumCos += Math.cos(a);
      sumY += y + 0.5;
      rural += world.grid[x][y].populationDensity * 2500;
    }
    let cx = (Math.atan2(sumSin, sumCos) / (Math.PI * 2)) * W;
    if (cx < 0) cx += W;
    const seat = seats[i];
    const seatCity = seat.cityId >= 0 ? world.cities.find((c) => c.id === seat.cityId) : undefined;
    const cityPop = world.cities
      .filter((c) => {
        const cell = world.getCell(c.x, c.y);
        return cell?.provinceIndex === id;
      })
      .reduce((s, c) => s + c.population, 0);
    const old = previous.get(`${seat.x},${seat.y}`);
    const p: Province = {
      id,
      name: old?.name ?? provinceName(world, seatCity, cells, noise.random),
      color: old?.color ?? tint(nation.color, (noise.random() - 0.5) * 0.3),
      nationIndex: nationId,
      capitalCityId: seatCity ? seatCity.id : -1,
      seatX: seat.x,
      seatY: seat.y,
      centroidX: cx,
      centroidY: sumY / cells.length,
      area: cells.length * CELL_KM2,
      population: Math.round(cityPop + rural),
    };
    world.provinces.push(p);
  });

  for (const city of world.cities) {
    if (city.nationIndex !== nationId) continue;
    const cell = world.getCell(city.x, city.y);
    city.provinceIndex = cell?.provinceIndex ?? -1;
  }
  // Province capitals: seat city, else the largest city inside
  for (const p of world.provinces) {
    if (p.nationIndex !== nationId || p.capitalCityId >= 0) continue;
    const biggest = world.cities
      .filter((c) => c.provinceIndex === p.id)
      .sort((a, b) => b.population - a.population)[0];
    if (biggest) p.capitalCityId = biggest.id;
  }
}

export async function generateProvinces(ctx: GeneratorContext): Promise<void> {
  const { world, noise, onProgress } = ctx;
  world.provinces = [];
  for (let x = 0; x < world.width; x++)
    for (let y = 0; y < world.height; y++) world.grid[x][y].provinceIndex = undefined;

  const byNation: number[][] = world.nations.map(() => []);
  for (let x = 0; x < world.width; x++)
    for (let y = 0; y < world.height; y++) {
      const cell = world.grid[x][y];
      const n = cell.nationIndex ?? -1;
      if (!cell.isWater && n >= 0 && n < byNation.length) byNation[n].push(y * world.width + x);
    }
  fields.delete(world);
  for (let i = 0; i < world.nations.length; i++) {
    partitionNation(world, noise, i, [], false, byNation[i]);
    if (i % 3 === 0) {
      onProgress?.((i / world.nations.length) * 100);
      await yieldFrame();
    }
  }
}
