import type { GeneratorContext } from "./types";
import type { City, Point, WorldData } from "../WorldData";
import { RESOURCE_INFO, assignWealthTiers, type ResourceKind } from "./generateEconomy";
import { MinHeap } from "../util/grid";

// Trade flows over the road and sea-lane network. Every market town sends
// goods to every settlement it can reach, by a gravity model (both ends'
// population and wealth, decaying with route cost); each pair's flow follows
// the cheapest route, so roads and lanes pick up `traffic` and the
// settlements they pass through earn from it. Wars close the links between
// belligerents (caravans divert or stop) and embargo trade between them.

export interface CityTrade {
  volume: number; // goods passing through a year, relative units
  rank: number; // 0..1 percentile among settlements
  caravans: number; // busy road links
  lanes: number; // busy sea lanes
  cut: number; // links closed by war
}

const tradeOf = new WeakMap<City, CityTrade>();
export function cityTrade(c: City): CityTrade | undefined {
  return tradeOf.get(c);
}

// Trade role of a settlement for tooltips
export function tradeRole(t: CityTrade | undefined, port: boolean): string {
  if (!t || t.volume <= 0) return "Isolated";
  if (t.rank >= 0.985) return port ? "Great entrepôt" : "Great caravan city";
  if (t.rank >= 0.92) return port ? "Busy harbour" : "Trade hub";
  if (t.rank >= 0.7) return "Busy market";
  if (t.rank >= 0.35) return "Local market";
  return "Backwater";
}

// Goods a settlement sells: its local resources, most valuable first
export function cityExports(c: City): string[] {
  const kinds = (c.resources ?? []).filter((k) => k in RESOURCE_INFO) as ResourceKind[];
  return kinds.sort((a, b) => RESOURCE_INFO[b].value - RESOURCE_INFO[a].value).map((k) => RESOURCE_INFO[k].label.toLowerCase());
}

const lengths = new WeakMap<object, number>();
function lengthOf(o: { points: Point[] }): number {
  let l = lengths.get(o);
  if (l === undefined) {
    l = 0;
    const p = o.points;
    for (let i = 1; i < p.length; i++) l += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    lengths.set(o, l);
  }
  return l;
}

export async function generateTrade(ctx: GeneratorContext): Promise<void> {
  computeTrade(ctx.world);
  ctx.onProgress?.(100);
}

// Recomputes all flows, traffic, city trade and trade-inclusive wealth.
export function computeTrade(world: WorldData) {
  const cities = world.cities;
  const n = cities.length;
  const W = world.width;
  const resScale = W / 800;
  if (n === 0) return;
  const nations = world.nations.length;
  const atWar = new Uint8Array(nations);
  const rel = (a: number, b: number) => (a >= 0 && b >= 0 && a !== b ? (world.relations[a]?.[b] ?? "Neutral") : "Self");
  for (let a = 0; a < nations; a++)
    for (let b = 0; b < nations; b++) if (a !== b && world.relations[a]?.[b] === "War") atWar[a] = 1;

  // Route endpoints -> city index (ids normally equal indices; edits may
  // have shifted them, so fall back to the city sitting at the endpoint)
  let bins: Map<number, number[]> | null = null;
  const near = (c: City, p: Point) => {
    let dx = (((c.x - p.x) % W) + W) % W;
    dx = Math.min(dx, W - dx);
    return Math.hypot(dx, c.y - p.y) < 1.5;
  };
  const resolve = (id: number, p: Point): number => {
    const c = cities[id];
    if (c && c.id === id && near(c, p)) return id;
    if (!bins) {
      bins = new Map();
      cities.forEach((c, i) => {
        const k = Math.floor(c.y / 4) * 4096 + Math.floor((((c.x % W) + W) % W) / 4);
        const l = bins!.get(k);
        if (l) l.push(i);
        else bins!.set(k, [i]);
      });
    }
    const px = ((p.x % W) + W) % W;
    const bx = Math.floor(px / 4);
    const by = Math.floor(p.y / 4);
    const BX = Math.ceil(W / 4);
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++)
        for (const i of bins.get((by + oy) * 4096 + ((bx + ox + BX) % BX)) ?? []) if (near(cities[i], p)) return i;
    return -1;
  };

  // --- Graph (CSR adjacency); edges 0..R-1 are roads, the rest sea lanes ---
  const roads = world.worldRoads;
  const lanes = world.seaRoutes;
  const E = roads.length + lanes.length;
  const ea = new Int32Array(E).fill(-1);
  const eb = new Int32Array(E).fill(-1);
  const ecost = new Float64Array(E);
  const cut = new Int32Array(n);
  const roadMul = [1.3, 1.0, 0.8]; // tracks are slow, highways quick
  const border = 6 * resScale; // tolls and customs
  for (let e = 0; e < E; e++) {
    const sea = e >= roads.length;
    const r = sea ? lanes[e - roads.length] : roads[e];
    r.traffic = 0;
    if (r.points.length < 2) continue;
    const a = resolve(r.a, r.points[0]);
    const b = resolve(r.b, r.points[r.points.length - 1]);
    if (a < 0 || b < 0 || a === b) continue;
    const na = cities[a].nationIndex;
    const nb = cities[b].nationIndex;
    const relation = rel(na, nb);
    if (relation === "War") {
      cut[a]++;
      cut[b]++;
      continue;
    }
    // Shipping is cheap per league but costs loading and harbour dues
    let c = sea ? lengthOf(r) * 0.45 + 8 * resScale : lengthOf(r) * (roadMul[r.tier] ?? 1);
    if (relation !== "Self") c += relation === "Rival" ? border * 3 : relation === "Alliance" || relation === "Vassal" || relation === "Overlord" ? border * 0.3 : border;
    // Lands at war are unsafe for merchants
    if ((na >= 0 && atWar[na]) || (nb >= 0 && atWar[nb])) c *= 1.35;
    ea[e] = a;
    eb[e] = b;
    ecost[e] = c;
  }
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < E; e++)
    if (ea[e] >= 0) {
      deg[ea[e] + 1]++;
      deg[eb[e] + 1]++;
    }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(deg[n]);
  const fill = deg.slice(0, n);
  for (let e = 0; e < E; e++)
    if (ea[e] >= 0) {
      adj[fill[ea[e]]++] = e;
      adj[fill[eb[e]]++] = e;
    }

  // --- Masses: people and what the land around them produces ---
  const mass = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = cities[i];
    c.baseWealth ??= c.wealth ?? 0;
    mass[i] = Math.pow(Math.max(50, c.population) / 10000, 0.75) * (1 + c.baseWealth / 25);
  }
  // Long-distance trade starts at markets: towns, cities, ports
  const sources: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = cities[i];
    if (c.size >= 1 || c.isCapital || c.isPort) sources.push(i);
  }
  sources.sort((a, b) => mass[b] - mass[a]);
  if (sources.length > 450) sources.length = 450;

  // --- Flows: one shortest-path tree per source; each destination's flow
  // runs back up the tree, so every edge collects what passes through it ---
  const L = 70 * resScale; // cost at which trade falls to 1/e
  const maxCost = L * 4.5;
  const dist = new Float64Array(n);
  const via = new Int32Array(n); // edge into the node on its cheapest route
  const stamp = new Int32Array(n);
  const done = new Int32Array(n);
  const order = new Int32Array(n);
  const sub = new Float64Array(n);
  const through = new Float64Array(n);
  const flow = new Float64Array(E);
  const heap = new MinHeap(1024);
  let epoch = 0;
  for (const s of sources) {
    epoch++;
    heap.clear();
    dist[s] = 0;
    via[s] = -1;
    stamp[s] = epoch;
    heap.push(0, s);
    let settled = 0;
    while (heap.size > 0) {
      const d = heap.peekKey();
      const u = heap.pop();
      if (done[u] === epoch || d > dist[u]) continue;
      done[u] = epoch;
      order[settled++] = u;
      sub[u] = 0;
      for (let k = deg[u]; k < deg[u + 1]; k++) {
        const e = adj[k];
        const v = ea[e] === u ? eb[e] : ea[e];
        const nd = d + ecost[e];
        if (nd > maxCost) continue;
        if (stamp[v] !== epoch || nd < dist[v]) {
          stamp[v] = epoch;
          dist[v] = nd;
          via[v] = e;
          heap.push(nd, v);
        }
      }
    }
    const ns = cities[s].nationIndex;
    for (let k = settled - 1; k >= 1; k--) {
      const j = order[k];
      // Belligerents embargo each other, though goods may still pass through
      if (rel(ns, cities[j].nationIndex) !== "War") sub[j] += mass[s] * mass[j] * Math.exp(-dist[j] / L);
      const f = sub[j];
      through[j] += f;
      const e = via[j];
      flow[e] += f;
      sub[ea[e] === j ? eb[e] : ea[e]] += f;
    }
    through[s] += sub[s];
  }

  // --- Publish ---
  let maxFlow = 0;
  for (let e = 0; e < E; e++) maxFlow = Math.max(maxFlow, flow[e]);
  const busy = maxFlow * 0.01;
  const caravans = new Int32Array(n);
  const shipLanes = new Int32Array(n);
  for (let e = 0; e < E; e++) {
    if (ea[e] < 0) continue;
    const sea = e >= roads.length;
    (sea ? lanes[e - roads.length] : roads[e]).traffic = maxFlow > 0 ? flow[e] / maxFlow : 0;
    if (flow[e] < busy || flow[e] <= 0) continue;
    const cnt = sea ? shipLanes : caravans;
    cnt[ea[e]]++;
    cnt[eb[e]]++;
  }
  const ranked = Array.from({ length: n }, (_, i) => i).sort((a, b) => through[a] - through[b]);
  const rank = new Float64Array(n);
  ranked.forEach((i, k) => (rank[i] = through[i] > 0 ? k / Math.max(1, n - 1) : 0));
  let sum = 0;
  let traders = 0;
  for (let i = 0; i < n; i++)
    if (through[i] > 0) {
      sum += through[i];
      traders++;
    }
  const mean = traders ? sum / traders : 1;
  for (let i = 0; i < n; i++) {
    const c = cities[i];
    tradeOf.set(c, { volume: through[i], rank: rank[i], caravans: caravans[i], lanes: shipLanes[i], cut: cut[i] });
    // Busy junctions and harbours grow rich on tolls, markets and warehousing
    c.wealth = (c.baseWealth ?? 0) + 4 * Math.sqrt(through[i] / mean);
  }
  assignWealthTiers(world);
}
