import type { City, Nation, Point, Road, WorldData } from "../WorldData";
import { cityNameFor, cityRadiusM, finalizeCity } from "../generators/generateCities";
import { connectCity } from "../generators/generateRoads";
import { localWealth } from "../generators/generateEconomy";
import { computeTrade, cityTrade } from "../generators/generateTrade";

export type EconEventKind = "growth" | "decline" | "ruin" | "founding";
type Log = (kind: EconEventKind, text: string, x: number, y: number) => void;

interface CityState {
  owner: Nation | undefined; // realm that held it last year
  since: number; // year it last changed hands
  pop0: number; // population when first seen: growth is relative to it
  promoteAt: number; // population at which it rises a tier
  drawnR: number; // built-up radius when last redrawn
  milestone: number; // population milestones already in the chronicle
}

const MILESTONES = [100000, 250000, 500000, 1000000];
const TOWN_AT = 6000;
const CITY_AT = 60000;

// Yearly life of settlements during the history simulation: prosperous,
// peaceful, well-traded places grow; besieged and occupied ones shrink, and
// the smallest may be razed to ruins; settlers found villages on empty
// fertile land. Trade flows (~25 ms) are recomputed every decade, or at
// most every five years while the map of wars keeps changing.
export class EconomySim {
  public touched = new Set<City>(); // settlements whose drawing must be rebuilt
  public removed: City[] = []; // settlements gone to ruin
  public tradeChanged = false; // traffic and wealth were recomputed
  private state = new WeakMap<City, CityState>();
  private lastTrade = 0;
  private warKey = "";
  private fertile: Int32Array | null = null; // land cells fit for new villages

  // Called by the UI once it has redrawn
  public clearDirty() {
    this.touched.clear();
    this.removed = [];
    this.tradeChanged = false;
  }

  // One year; returns true when settlements were added or removed (ids shift)
  public step(world: WorldData, year: number, rand: () => number, log: Log): boolean {
    const n = world.nations.length;
    const atWar = new Uint8Array(n);
    let warKey = "";
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        if (world.relations[a]?.[b] === "War") {
          atWar[a] = atWar[b] = 1;
          warKey += world.nations[a].name + "/" + world.nations[b].name + ";";
        }
    if (year - this.lastTrade >= 10 || (warKey !== this.warKey && year - this.lastTrade >= 5)) {
      computeTrade(world);
      this.lastTrade = year;
      this.warKey = warKey;
      this.tradeChanged = true;
    }

    const ruins: { city: City; by: string }[] = [];
    for (const c of world.cities) {
      let st = this.state.get(c);
      const nation = world.nations[c.nationIndex];
      if (!st) {
        st = {
          owner: nation,
          since: -99,
          pop0: c.population,
          promoteAt: Math.max(c.size === 0 ? TOWN_AT : CITY_AT, c.population * 1.25),
          drawnR: c.radiusM,
          milestone: MILESTONES.filter((m) => c.population >= m).length,
        };
        this.state.set(c, st);
      }
      let pop = c.population;
      if (st.owner !== nation) {
        // Taken by force: a sack costs a share of the people (towns and
        // cities only, and not again each time a front sweeps back and forth)
        const prev = st.owner ? world.nations.indexOf(st.owner) : -1;
        if (c.size >= 1 && year - st.since >= 10 && prev >= 0 && world.relations[c.nationIndex]?.[prev] === "War") {
          const loss = 0.08 + 0.17 * rand();
          pop *= 1 - loss;
          if (c.population >= 80000 && loss > 0.18 && nation) log("decline", `${c.name} is sacked by the armies of ${nation.name}`, c.x, c.y);
        }
        st.owner = nation;
        st.since = year;
      }
      const cell = world.grid[((Math.floor(c.x) % world.width) + world.width) % world.width]?.[Math.floor(c.y)];
      const fert = cell?.populationDensity ?? 0.3;
      const trade = cityTrade(c)?.rank ?? 0;
      const prov = world.provinces[c.provinceIndex ?? -1];
      const occupied = !!prov && prov.nationIndex >= 0 && prov.nationIndex !== c.nationIndex;
      // Room to grow: fertile, well-traded places can sustain a few times
      // their size when first seen, the rest level off; great cities less so
      const room = (0.4 + 0.6 * fert + 1.4 * trade * trade + (c.isCapital ? 0.3 : 0)) / (1 + st.pop0 / 150000);
      const cap = st.pop0 * (1 + room);
      let r = (0.0015 + 0.006 * fert + 0.007 * trade + (c.isPort ? 0.001 : 0)) * (1 - pop / cap);
      r = Math.max(-0.004, r);
      if (c.nationIndex >= 0 && atWar[c.nationIndex]) r -= 0.004;
      if (occupied) r -= 0.02;
      else if (year - st.since < 6) r -= 0.01; // a new master unsettles trade and farms
      r += (rand() - 0.5) * 0.006;
      pop = Math.max(50, pop * (1 + r));

      // Razed (rarely), or abandoned once war has emptied it
      const emptied = pop < 250 && pop < st.pop0 * 0.3;
      if (!c.isCapital && c.size === 0 && (emptied || (occupied && pop < 1500 && rand() < 0.0002))) {
        ruins.push({ city: c, by: occupied && nation ? nation.name : "" });
        continue;
      }
      this.setPopulation(c, st, Math.round(pop), log);
    }
    if (ruins.length) for (const { city, by } of ruins) this.ruin(world, city, by, log);
    const founded = this.found(world, atWar, rand, log);
    return ruins.length > 0 || founded;
  }

  private setPopulation(c: City, st: CityState, pop: number, log: Log) {
    const before = c.population;
    c.population = pop;
    c.radiusM = cityRadiusM(pop);
    const size = c.size;
    if (pop >= st.promoteAt && c.size < 2) {
      c.size++;
      st.promoteAt = Math.max(CITY_AT, pop * 1.25);
      if (c.size === 2) log("growth", `${c.name} has grown into a city`, c.x, c.y);
    } else if (c.size === 2 && pop < 25000 && !c.isCapital) {
      c.size = 1;
      st.promoteAt = Math.max(CITY_AT, pop * 1.5);
      log("decline", `${c.name} dwindles to a town`, c.x, c.y);
    } else if (c.size === 1 && pop < 2500) {
      c.size = 0;
      st.promoteAt = Math.max(TOWN_AT, pop * 1.5);
    }
    while (st.milestone < MILESTONES.length && pop >= MILESTONES[st.milestone] && before < MILESTONES[st.milestone]) {
      log("growth", `${c.name} passes ${MILESTONES[st.milestone].toLocaleString()} souls`, c.x, c.y);
      st.milestone++;
    }
    // Redraw only on visible change: a new tier or a noticeably larger footprint
    if (size !== c.size || Math.abs(c.radiusM - st.drawnR) > st.drawnR * 0.1) {
      st.drawnR = c.radiusM;
      this.touched.add(c);
    }
  }

  // The settlement is gone: a ruin marks the spot, the roads through it
  // stay as one road between its neighbours, ids are re-indexed
  private ruin(world: WorldData, c: City, by: string, log: Log) {
    const idx = world.cities.indexOf(c);
    if (idx < 0) return;
    log("ruin", by ? `${c.name} is razed by ${by}` : `${c.name} is abandoned and falls to ruin`, c.x, c.y);
    world.pois.push({ kind: "ruins", x: c.x, y: c.y, angle: 0, name: `Ruins of ${c.name}`, nationIndex: c.nationIndex });
    world.poisEdited = true;
    this.removed.push(c);

    const id = c.id;
    const mine = world.worldRoads.filter((r) => (r.a === id) !== (r.b === id));
    const kept = world.worldRoads.filter((r) => r.a !== id && r.b !== id);
    // Orient every road away from the ruin, then join the first to each other
    // one (never into a loop back to the same neighbour)
    const out = mine.map((r) => (r.a === id ? r : { ...r, a: r.b, b: r.a, points: [...r.points].reverse() }));
    for (let k = 1; k < out.length; k++) if (out[k].b !== out[0].b) kept.push(join(out[0], out[k], world.width));
    world.worldRoads = kept;
    world.seaRoutes = world.seaRoutes.filter((r) => r.a !== id && r.b !== id);
    world.roadsEdited = true;

    world.cities.splice(idx, 1);
    const remap = new Map<number, number>();
    world.cities.forEach((city, i) => {
      remap.set(city.id, i);
      city.id = i;
    });
    const fix = (v: number) => remap.get(v) ?? -1;
    for (const r of world.worldRoads) {
      r.a = fix(r.a);
      r.b = fix(r.b);
    }
    for (const r of world.seaRoutes) {
      r.a = fix(r.a);
      r.b = fix(r.b);
    }
    for (const p of world.provinces) if (p.capitalCityId >= 0) p.capitalCityId = fix(p.capitalCityId);
  }

  // Settlers found a village on fertile, peaceful land well away from others
  private found(world: WorldData, atWar: Uint8Array, rand: () => number, log: Log): boolean {
    const W = world.width;
    const H = world.height;
    const resScale = W / 800;
    if (!this.fertile) {
      const cells: number[] = [];
      for (let x = 0; x < W; x++)
        for (let y = 0; y < H; y++) {
          const cell = world.grid[x][y];
          if (!cell.isWater && cell.populationDensity >= 0.4) cells.push(y * W + x);
        }
      this.fertile = Int32Array.from(cells);
    }
    const cells = this.fertile;
    if (!cells.length || rand() >= 0.3 * ((W * H) / (800 * 450))) return false;
    const minD = 4.5 * resScale; // villages are generated ~3.2 apart
    for (let attempt = 0; attempt < 16; attempt++) {
      const i = cells[Math.floor(rand() * cells.length)];
      const cx = (i % W) + 0.2 + rand() * 0.6;
      const cy = Math.floor(i / W) + 0.2 + rand() * 0.6;
      const cell = world.grid[i % W][Math.floor(i / W)];
      const o = cell.nationIndex ?? -1;
      if (o < 0 || o >= world.nations.length || atWar[o]) continue;
      const prov = world.provinces[cell.provinceIndex ?? -1];
      if (!prov || prov.nationIndex !== o) continue;
      if (world.sampler.coastField(cx, cy, 6) < 0.08) continue;
      let ok = true;
      let nearest: City | null = null;
      let nd = Infinity;
      for (const c of world.cities) {
        let dx = Math.abs(c.x - cx);
        if (dx > W / 2) dx = W - dx;
        const d = Math.hypot(dx, c.y - cy);
        if (d < minD) {
          ok = false;
          break;
        }
        if (d < nd && c.nationIndex === o) {
          nd = d;
          nearest = c;
        }
      }
      if (!ok) continue;
      const city: City = {
        id: world.cities.length,
        name: cityNameFor(world, cx, cy, rand),
        x: cx,
        y: cy,
        nationIndex: o,
        provinceIndex: cell.provinceIndex,
        isCapital: false,
        size: 0,
        population: 0,
        radiusM: 0,
        seed: 0,
      };
      finalizeCity(world, city, cell.populationDensity * 0.3);
      const lw = localWealth(world, cx, cy);
      city.wealth = city.baseWealth = lw.wealth + (city.isPort ? 6 : 0) + (cell.hasRiver ? 3 : 0);
      city.resources = lw.kinds;
      city.wealthTier = 1;
      world.cities.push(city);
      connectCity(world, city);
      world.roadsEdited = true;
      const from = nearest ? ` from ${nearest.name}` : "";
      log("founding", `Settlers${from} found the village of ${city.name} in ${world.nations[o].name}`, cx, cy);
      return true;
    }
    return false;
  }
}

// Joins two roads leaving the same spot into one running from b's far end to
// a's far end (x is unwrapped per road, so b is shifted to meet a)
function join(a: Road, b: Road, W: number): Road {
  const a0 = a.points[0];
  const b0 = b.points[0];
  const shift = Math.round((a0.x - b0.x) / W) * W;
  const pts: Point[] = [];
  for (let i = b.points.length - 1; i >= 1; i--) pts.push({ x: b.points[i].x + shift, y: b.points[i].y });
  for (const p of a.points) pts.push(p);
  return { points: pts, tier: Math.min(a.tier, b.tier), a: b.b, b: a.b };
}
