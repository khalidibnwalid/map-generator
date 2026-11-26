import { CELL_METERS } from "../../core/FieldNoise";
import { WorldData, type City } from "../WorldData";
import { sampleCurve } from "../util/curves";
import {
  type Poly,
  type Vec,
  area,
  centroid,
  circlePoly,
  clipHalfPlane,
  contours,
  distToSegment,
  insetConvex,
  longestEdge,
  pointInPoly,
  rng,
  simplifyPoly,
  voronoi,
} from "./geom";
import { StreetGraph, type StreetKind } from "./streets";
import {
  type CityLayout,
  type Landmark,
  type Ward,
  type WardType,
  SegmentHash,
  TYPE_NAMES,
  bbox,
  dirName,
  internals,
  riverBox,
  rotRect,
  sampleField,
  styleFor,
  subdivide,
} from "./CityLayout";

// City plans, generated from what is around the city (local meters, +x
// east, +y south). The street network grows: the world's roads come in
// first, then the harbor's quay street, river embankments and the street
// inside the walls; side streets branch off them and off each other,
// following the lie of the land (along slopes rather than up them), and
// stop at the water, the town's edge or the streets they run into. Blocks
// are the spaces the streets enclose; districts are given out by where the
// blocks are (the market at the crossroads, the castle on the heights, the
// docks on the harbor, workshops by the river). Plot by plot detail is
// built lazily per block (lots.ts). Yields now and then so the work can be
// time-sliced.

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function* buildCityLayout(world: WorldData, city: City): Generator<void, CityLayout> {
  const plan = city.plan ?? {};
  const rand = rng((plan.seed ?? city.seed) || 1);
  const density = clamp(plan.density ?? 1, 0.6, 1.4);
  const R = city.radiusM;
  const Ru = R * (city.size === 0 ? 1.25 : 1.35);
  const Rf = Ru + Math.min(2500, Math.max(450, 300 + R * 0.8));
  const ext = Rf + 80;
  const res = Math.max(5, Math.min(25, Rf / 180));
  const n = Math.ceil((2 * ext) / res) + 1;
  const origin = -ext;
  const W = world.width;
  const toCell = (m: number) => m / CELL_METERS;
  const sampler = world.sampler;
  const style = styleFor(world, city);

  // ===================== Terrain =====================
  const octaves = Math.min(11, Math.max(4, Math.ceil(Math.log2((CELL_METERS * 2) / res)) + 1));
  const coastF = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const wy = city.y + toCell(origin + j * res);
    for (let i = 0; i < n; i++) coastF[j * n + i] = sampler.coastField(city.x + toCell(origin + i * res), wy, octaves) * CELL_METERS;
    if (j % 24 === 23) yield;
  }
  const riverF = new Float32Array(n * n).fill(1e6);
  const extC = toCell(ext + 1000);
  for (const r of world.rivers) {
    const b = riverBox(r);
    const shift = Math.round((city.x - (b[0] + b[2]) / 2) / W) * W;
    if (city.x < b[0] + shift - extC || city.x > b[2] + shift + extC) continue;
    if (city.y < b[1] - extC || city.y > b[3] + extC) continue;
    sampleCurve(r.points, r.widths, toCell(res / 2), (x, y, w) => {
      const mx = (x + shift - city.x) * CELL_METERS;
      const my = (y - city.y) * CELL_METERS;
      const hw = w / 2;
      if (Math.abs(mx) > ext + hw || Math.abs(my) > ext + hw) return;
      const rr = hw + 2 * res;
      const i0 = Math.max(0, Math.floor((mx - rr - origin) / res));
      const i1 = Math.min(n - 1, Math.ceil((mx + rr - origin) / res));
      const j0 = Math.max(0, Math.floor((my - rr - origin) / res));
      const j1 = Math.min(n - 1, Math.ceil((my + rr - origin) / res));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(origin + i * res - mx, origin + j * res - my) - hw;
          const k = j * n + i;
          if (d < riverF[k]) riverF[k] = d;
        }
    });
  }
  const field = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) field[k] = Math.min(coastF[k], riverF[k]);
  for (let i = 0; i < n; i++) {
    field[i] = Math.max(field[i], 1);
    field[(n - 1) * n + i] = Math.max(field[(n - 1) * n + i], 1);
    field[i * n] = Math.max(field[i * n], 1);
    field[i * n + n - 1] = Math.max(field[i * n + n - 1], 1);
  }
  const waterLoops = contours(field, n, res, origin);
  // Ground height on a coarser grid, in meters
  const er = res * 4;
  const en = Math.ceil((2 * ext) / er) + 1;
  const elevF = new Float32Array(en * en);
  for (let j = 0; j < en; j++)
    for (let i = 0; i < en; i++)
      elevF[j * en + i] = WorldData.elevationMeters(sampler.elevation(city.x + toCell(origin + i * er), city.y + toCell(origin + j * er)));
  yield;

  const L: CityLayout = {
    city, R, Ru, Rf, res, n, origin, field, coastF, riverF, waterLoops,
    wards: [], arteries: [], wall: null, bridges: [], piers: [], boats: [],
    fields: [], farmTrees: [], farmBuildings: [], landmarks: [], labels: [], streetLabels: [], style,
    streets: [], quays: [], aprons: [], moles: [], cranes: [], slips: [], plan,
  };
  const land = (x: number, y: number) => sampleField(L, field, x, y);
  const coastAt = (x: number, y: number) => sampleField(L, coastF, x, y);
  const riverAt = (x: number, y: number) => sampleField(L, riverF, x, y);
  const elevAt = (x: number, y: number) => {
    const fx = clamp((x - origin) / er, 0, en - 1.001);
    const fy = clamp((y - origin) / er, 0, en - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const a = elevF[j * en + i];
    const b = elevF[j * en + i + 1];
    const c = elevF[(j + 1) * en + i];
    const d = elevF[(j + 1) * en + i + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
  // Uphill direction and steepness (meters per meter)
  const slopeAt = (x: number, y: number) => {
    const h = er;
    const gx = (elevAt(x + h, y) - elevAt(x - h, y)) / (2 * h);
    const gy = (elevAt(x, y + h) - elevAt(x, y - h)) / (2 * h);
    return { gx, gy, s: Math.hypot(gx, gy) };
  };
  // Seaward unit normal at a shore point (from the coast field's gradient)
  const seaward = (x: number, y: number, f = coastAt) => {
    const gx = f(x + res, y) - f(x - res, y);
    const gy = f(x, y + res) - f(x, y - res);
    const gl = Math.hypot(gx, gy) || 1;
    return { x: -gx / gl, y: -gy / gl };
  };

  // ===================== Main roads =====================
  const roadWidth = [8, 11, 15];
  for (const road of world.worldRoads) {
    const b0 = road.points[0];
    const shift = Math.round((city.x - b0.x) / W) * W;
    let run: Vec[] = [];
    let touchesCore = false;
    const flush = () => {
      if (run.length > 1 && touchesCore) L.arteries.push({ pts: run, width: roadWidth[road.tier] ?? 9 });
      run = [];
      touchesCore = false;
    };
    const reach = toCell(Rf + 2000);
    if (!road.points.some((p) => Math.abs(p.x + shift - city.x) < reach && Math.abs(p.y - city.y) < reach)) continue;
    const xs: number[] = [];
    sampleCurve(road.points, road.points.map(() => 0), toCell(Math.max(12, res)), (x, y) => {
      xs.push(x, y);
    });
    for (let k = 0; k < xs.length; k += 2) {
      const mx = (xs[k] + shift - city.x) * CELL_METERS;
      const my = (xs[k + 1] - city.y) * CELL_METERS;
      const r = Math.hypot(mx, my);
      if (r <= Rf) {
        run.push({ x: mx, y: my });
        if (r < Ru) touchesCore = true;
      } else flush();
    }
    flush();
  }
  // A town always has a few ways out: more radial roads where the gaps are widest,
  // keeping to dry, gentle ground
  const minArteries = city.isCapital ? 6 : city.size >= 2 ? 5 : city.size === 1 ? 3 : 2;
  const angleOf = (pts: Vec[]) => {
    const far = pts.reduce((b, p) => (Math.hypot(p.x, p.y) > Math.hypot(b.x, b.y) ? p : b), pts[0]);
    return Math.atan2(far.y, far.x);
  };
  for (let guard = 0; L.arteries.length < minArteries && guard < 12; guard++) {
    const angles = L.arteries.map((a) => angleOf(a.pts)).sort((a, b) => a - b);
    let heading = rand() * Math.PI * 2;
    if (angles.length) {
      let bestGap = -1;
      for (let i = 0; i < angles.length; i++) {
        const a = angles[i];
        const b = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
        if (b - a > bestGap) {
          bestGap = b - a;
          heading = (a + b) / 2;
        }
      }
      if (bestGap < 0.5) break;
    }
    const pts: Vec[] = [{ x: 0, y: 0 }];
    let p = { x: 0, y: 0 };
    let h = heading;
    while (Math.hypot(p.x, p.y) < Rf) {
      let moved = false;
      for (const delta of [0, 0.2, -0.2, 0.4, -0.4, 0.7, -0.7, 1.1, -1.1]) {
        const q = { x: p.x + Math.cos(h + delta) * 25, y: p.y + Math.sin(h + delta) * 25 };
        // Dry land, and not straight up a steep slope
        if (coastAt(q.x, q.y) > 8 && riverAt(q.x, q.y) > 4 && Math.abs(elevAt(q.x, q.y) - elevAt(p.x, p.y)) < 25 * 0.18) {
          h += delta * 0.5 + (rand() - 0.5) * 0.1;
          p = q;
          moved = true;
          break;
        }
      }
      if (!moved) break;
      pts.push(p);
    }
    if (pts.length < 6 && L.arteries.length > 0) break;
    L.arteries.push({ pts, width: city.size >= 1 ? 10 : 7 });
  }
  // Roads bend a little as they come through town
  for (const a of L.arteries) {
    const amp = 6 + rand() * 10;
    const wave = 180 + rand() * 140;
    const phase = rand() * 6.28;
    let s = 0;
    a.pts = a.pts.map((p, i) => {
      if (i > 0) s += Math.hypot(p.x - a.pts[i - 1].x, p.y - a.pts[i - 1].y);
      const q = a.pts[Math.min(a.pts.length - 1, i + 1)];
      const o = a.pts[Math.max(0, i - 1)];
      const dl = Math.hypot(q.x - o.x, q.y - o.y) || 1;
      const off = amp * Math.sin(Math.PI * Math.min(1, Math.hypot(p.x, p.y) / Ru)) * Math.sin(s / wave + phase);
      const np = { x: p.x - ((q.y - o.y) / dl) * off, y: p.y + ((q.x - o.x) / dl) * off };
      return land(np.x, np.y) > 3 || land(p.x, p.y) <= 3 ? np : p;
    });
  }
  yield;

  // Distance to the nearest main road, on a coarse grid (roadside building spreads along them)
  const ar = 40;
  const an = Math.ceil((2 * ext) / ar) + 1;
  const roadD = new Float32Array(an * an).fill(1e6);
  for (const a of L.arteries)
    for (let i = 0; i + 1 < a.pts.length; i++) {
      const p = a.pts[i];
      const q = a.pts[i + 1];
      const i0 = Math.max(0, Math.floor((Math.min(p.x, q.x) - 200 - origin) / ar));
      const i1 = Math.min(an - 1, Math.ceil((Math.max(p.x, q.x) + 200 - origin) / ar));
      const j0 = Math.max(0, Math.floor((Math.min(p.y, q.y) - 200 - origin) / ar));
      const j1 = Math.min(an - 1, Math.ceil((Math.max(p.y, q.y) + 200 - origin) / ar));
      for (let j = j0; j <= j1; j++)
        for (let k = i0; k <= i1; k++) {
          const d = distToSegment(origin + k * ar, origin + j * ar, p, q);
          if (d < roadD[j * an + k]) roadD[j * an + k] = d;
        }
    }
  const roadDist = (x: number, y: number) => {
    const i = clamp(Math.round((x - origin) / ar), 0, an - 1);
    const j = clamp(Math.round((y - origin) / ar), 0, an - 1);
    return roadD[j * an + i];
  };

  // How built-up a spot is (0..1): the core, thinning outward; ribbons along
  // the main roads; nothing on water or steep ground
  const core = R * (0.45 + 0.15 * density);
  const urban = (x: number, y: number) => {
    if (land(x, y) < 6) return 0;
    const d = Math.hypot(x, y);
    const base = 1 - smooth(core, Ru, d);
    const ribbon = (1 - smooth(25, 120, roadDist(x, y))) * (1 - smooth(Ru * 0.9, Ru * 1.7, d)) * 0.85;
    return Math.max(base, ribbon) * (1 - smooth(0.14, 0.32, slopeAt(x, y).s));
  };
  // Blocks are smaller in the old core, larger outward; denser plans have smaller blocks
  const blockLen = (x: number, y: number) => (50 + 62 * smooth(R * 0.15, Ru, Math.hypot(x, y))) / Math.sqrt(density);

  // ===================== Harbor site =====================
  // The most sheltered stretch of sea shore near the center (a bay, an
  // estuary), unless the plan says no harbor
  const wantsHarbor = plan.harbor ?? city.isPort;
  let harbor: { shore: Vec[]; quay: Vec[]; shelter: number; mid: Vec; out: Vec } | null = null;
  if (wantsHarbor) {
    // (contours wants the raster's border on land, or loops through it don't close)
    const coastB = coastF.slice();
    for (let i = 0; i < n; i++) {
      coastB[i] = Math.max(coastB[i], 1);
      coastB[(n - 1) * n + i] = Math.max(coastB[(n - 1) * n + i], 1);
      coastB[i * n] = Math.max(coastB[i * n], 1);
      coastB[i * n + n - 1] = Math.max(coastB[i * n + n - 1], 1);
    }
    const seaLoops = contours(coastB, n, res, origin);
    let best: { loop: Vec[]; i: number; score: number; shelter: number } | null = null;
    const shelterAt = (p: Vec, nrm: Vec) => {
      const o = { x: p.x + nrm.x * 50, y: p.y + nrm.y * 50 };
      let hits = 0;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        for (let s = 40; s <= 700; s += 35)
          if (coastAt(o.x + Math.cos(a) * s, o.y + Math.sin(a) * s) > 0) {
            hits++;
            break;
          }
      }
      return hits / 24;
    };
    for (const loop of seaLoops)
      for (let i = 0; i < loop.length; i += 3) {
        const p = loop[i];
        const d = Math.hypot(p.x, p.y);
        if (d > Ru * 1.05 || riverAt(p.x, p.y) < 30) continue;
        const nrm = seaward(p.x, p.y);
        // Water off it (the coast field is a smooth signed field, not meters: only its sign and trend count)
        if (coastAt(p.x + nrm.x * 60, p.y + nrm.y * 60) >= Math.min(-0.5, coastAt(p.x, p.y) - 1)) continue;
        const shelter = shelterAt(p, nrm);
        const score = shelter + 0.45 * (1 - d / Ru);
        if (!best || score > best.score) best = { loop, i, score, shelter };
      }
    if (best) {
      const want = clamp(160 + Math.sqrt(city.population) * 2.2, 220, 1100);
      const { loop } = best;
      const m = loop.length;
      const take = (dir: number) => {
        const out: Vec[] = [];
        let len = 0;
        for (let k = 1; k < m && len < want / 2; k++) {
          const p = loop[(best!.i + dir * k + m * 4) % m];
          const q = out.length ? out[out.length - 1] : loop[best!.i];
          if (Math.hypot(p.x, p.y) > Ru * 1.15 || riverAt(p.x, p.y) < 25) break;
          len += Math.hypot(p.x - q.x, p.y - q.y);
          out.push(p);
        }
        return out;
      };
      const shore = [...take(-1).reverse(), loop[best.i], ...take(1)];
      if (shore.length >= 4) {
        // The quay street runs 16 m inland of the waterfront
        const quay: Vec[] = [];
        let last: Vec | null = null;
        for (const p of shore) {
          const nrm = seaward(p.x, p.y);
          const q = { x: p.x - nrm.x * 16, y: p.y - nrm.y * 16 };
          if (!last || Math.hypot(q.x - last.x, q.y - last.y) >= 14) {
            quay.push(q);
            last = q;
          }
        }
        const mid = shore[shore.length >> 1];
        harbor = { shore, quay, shelter: best.shelter, mid, out: seaward(mid.x, mid.y) };
      }
    }
  }
  yield;

  // ===================== Walls =====================
  const walled = plan.walls ?? (city.isCapital || city.population >= 6000);
  let wallPoly: Poly | null = null;
  const wallShore: boolean[] = [];
  if (walled) {
    const Rw = R * 0.9;
    const count = Math.max(12, Math.min(56, Math.round((2 * Math.PI * Rw) / 70)));
    const phase = rand() * 10;
    wallPoly = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      // Walls keep to the higher ground where they can
      let r = Rw * (0.9 + 0.1 * Math.sin(a * 3 + phase) + 0.05 * (rand() - 0.5));
      const up = elevAt(Math.cos(a) * r * 1.08, Math.sin(a) * r * 1.08) - elevAt(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92);
      r *= 1 + clamp(up / 60, -0.06, 0.06);
      let rr = r;
      let shore = false;
      while (rr > R * 0.2 && coastAt(Math.cos(a) * rr, Math.sin(a) * rr) < 10) {
        rr -= res;
        shore = true;
      }
      wallPoly.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
      wallShore.push(shore);
    }
  }

  // ===================== Street network =====================
  const g = new StreetGraph(40);
  const snap = 10;
  // Main roads, simplified to ~25 m steps
  for (const a of L.arteries) {
    const pts: Vec[] = [];
    for (const p of a.pts) if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) >= 25) pts.push(p);
    if (pts[pts.length - 1] !== a.pts[a.pts.length - 1]) pts.push(a.pts[a.pts.length - 1]);
    g.addPolyline(pts, a.width, "artery", snap);
  }
  // The harbor's quay street
  if (harbor) g.addPolyline(harbor.quay, 12, "quay", snap);
  // Embankments along rivers through the old town
  const bankLoops = (() => {
    const shifted = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) shifted[k] = riverF[k] - 11;
    for (let i = 0; i < n; i++) {
      shifted[i] = Math.max(shifted[i], 1);
      shifted[(n - 1) * n + i] = Math.max(shifted[(n - 1) * n + i], 1);
      shifted[i * n] = Math.max(shifted[i * n], 1);
      shifted[i * n + n - 1] = Math.max(shifted[i * n + n - 1], 1);
    }
    return contours(shifted, n, res, origin);
  })();
  const embankments: Vec[][] = [];
  for (const loop of bankLoops) {
    let run: Vec[] = [];
    const flush = () => {
      if (run.length >= 4) embankments.push(run);
      run = [];
    };
    for (const p of loop) {
      const keep = Math.hypot(p.x, p.y) < R * 0.85 && coastAt(p.x, p.y) > 25 && urban(p.x, p.y) > 0.5;
      if (!keep) flush();
      else if (!run.length || Math.hypot(p.x - run[run.length - 1].x, p.y - run[run.length - 1].y) >= 15) run.push(p);
    }
    flush();
  }
  for (const e of embankments) g.addPolyline(e, 8, "quay", snap);
  // The street running just inside the walls
  if (wallPoly) {
    let run: Vec[] = [];
    const flush = () => {
      if (run.length >= 3) g.addPolyline(run, 7, "street", snap);
      run = [];
    };
    for (let i = 0; i <= wallPoly.length; i++) {
      const k = i % wallPoly.length;
      if (wallShore[k]) {
        flush();
        continue;
      }
      const p = wallPoly[k];
      const l = Math.hypot(p.x, p.y) || 1;
      const q = { x: p.x - (p.x / l) * 16, y: p.y - (p.y / l) * 16 };
      if (land(q.x, q.y) < 8) flush();
      else run.push(q);
    }
    flush();
  }
  yield;

  // --- Side streets grow off the main ones ---
  const pattern = plan.pattern ?? autoPattern(world, city, style.roofForm);
  type Agent = { node: number; h: number; gen: number; len: number; since: number; axis: number; ring: number };
  const agents: Agent[] = [];
  const maxGen = 5;
  const maxEdges = Math.min(16000, 1500 + Math.round(R * 5.5));
  // Seeds: points along every street laid so far, both sides
  const initial = g.edges.length;
  for (let id = 0; id < initial; id++) {
    const e = g.edges[id];
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    const axis = Math.atan2(B.y - A.y, B.x - A.x);
    let t = blockLen(A.x, A.y) * (0.3 + 0.5 * rand());
    while (t < len - 8) {
      const p = { x: A.x + ((B.x - A.x) * t) / len, y: A.y + ((B.y - A.y) * t) / len };
      for (const side of [1, -1]) {
        const h = axis + (side * Math.PI) / 2;
        const probe = { x: p.x + Math.cos(h) * 30, y: p.y + Math.sin(h) * 30 };
        if (urban(probe.x, probe.y) < 0.35 + 0.2 * rand()) continue;
        const node = g.nodeOnStreet(p, 2);
        if (node >= 0) agents.push({ node, h: h + (pattern === "organic" ? (rand() - 0.5) * 0.3 : 0), gen: 0, len: 0, since: 0, axis, ring: 0 });
      }
      t += blockLen(p.x, p.y) * (0.85 + 0.35 * rand());
    }
  }
  const widthOf = (gen: number) => (gen === 0 ? 7 : gen <= 2 ? 6 : 4.5);
  const kindOf = (gen: number): StreetKind => (gen <= 2 ? "street" : "lane");
  // The town fills from its center outward: agents nearest the center go first
  const distOf = (a: Agent) => Math.hypot(g.nodes[a.node].x, g.nodes[a.node].y);
  const heap: Agent[] = [];
  const push = (a: Agent) => {
    heap.push(a);
    for (let i = heap.length - 1; i > 0; ) {
      const j = (i - 1) >> 1;
      if (distOf(heap[j]) <= distOf(heap[i])) break;
      [heap[i], heap[j]] = [heap[j], heap[i]];
      i = j;
    }
  };
  const pop = (): Agent => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && distOf(heap[l]) < distOf(heap[m])) m = l;
        if (r < heap.length && distOf(heap[r]) < distOf(heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (const a of agents) push(a);
  agents.length = 0;
  for (let ai = 0; heap.length && g.edges.length < maxEdges; ai++) {
    const ag = pop();
    for (let step = 0; step < 80; step++) {
      const P = g.nodes[ag.node];
      // The heading for this step
      if (pattern === "grid") {
        const q = Math.PI / 2;
        ag.h = ag.axis + Math.round((ag.h - ag.axis) / q) * q;
      } else if (pattern === "radial") {
        const out = Math.atan2(P.y, P.x);
        ag.h = ag.ring ? out + (ag.ring * Math.PI) / 2 : out;
      } else {
        ag.h += (rand() - 0.5) * 0.26;
        // On slopes, streets run along the contours rather than up them
        const sl = slopeAt(P.x, P.y);
        if (sl.s > 0.03) {
          const t1 = Math.atan2(sl.gx, -sl.gy);
          const t2 = t1 + Math.PI;
          const d1 = Math.abs(Math.atan2(Math.sin(t1 - ag.h), Math.cos(t1 - ag.h)));
          const d2 = Math.abs(Math.atan2(Math.sin(t2 - ag.h), Math.cos(t2 - ag.h)));
          const target = d1 < d2 ? t1 : t2;
          const w = Math.min(0.55, sl.s * 4);
          ag.h += Math.atan2(Math.sin(target - ag.h), Math.cos(target - ag.h)) * w;
        }
      }
      const bl = blockLen(P.x, P.y);
      const stepLen = pattern === "grid" ? bl * 0.5 : 22;
      const q = { x: P.x + Math.cos(ag.h) * stepLen, y: P.y + Math.sin(ag.h) * stepLen };
      const u = urban(q.x, q.y);
      // The town thins out: streets stop where building does
      if (land(q.x, q.y) < 9 || u < (ag.gen ? 0.28 : 0.2) + 0.25 * rand() || Math.hypot(q.x, q.y) > Ru * 1.4) break;
      const r = g.extend(ag.node, q, widthOf(ag.gen), kindOf(ag.gen), Math.min(18, bl * 0.32));
      if (!r) break;
      ag.node = r.node;
      if (r.hit) break;
      ag.len += stepLen;
      ag.since += stepLen;
      if (ag.since >= bl * (0.85 + 0.3 * rand()) && ag.gen < maxGen) {
        ag.since = 0;
        for (const side of [1, -1]) {
          if (rand() > 0.9 * u) continue;
          const h = ag.h + (side * Math.PI) / 2 + (pattern === "organic" ? (rand() - 0.5) * 0.35 : 0);
          push({ node: ag.node, h, gen: ag.gen + 1, len: 0, since: 0, axis: ag.axis, ring: pattern === "radial" ? (ag.ring ? 0 : side) : 0 });
        }
      }
      if (ag.len > bl * (pattern === "grid" ? 8 : 6)) break;
    }
    if (ai % 200 === 199) yield;
  }
  g.pruneDeadEnds();
  // Dead ends running out into open country are not kept (cul-de-sacs in town are)
  const gone = new Set<number>();
  g.edges.forEach((e, id) => {
    if (!e.dead || e.kind === "artery" || e.kind === "quay") return;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    // (judged at the far end: a stub poking out of town goes)
    const far = g.degree(e.a) <= 1 ? A : B;
    if (urban((A.x + B.x) / 2, (A.y + B.y) / 2) < 0.55 || urban(far.x, far.y) < 0.5) gone.add(id);
  });
  yield;

  // ===================== Blocks =====================
  const faces = g.faces();
  const inner = new Set<string>(); // half-edges with a block on their left
  const wallInside = (x: number, y: number) => (wallPoly ? pointInPoly(wallPoly, x, y) : Math.hypot(x, y) < R * 0.85);
  const makeWard = (poly: Poly, front: number[], type: WardType): Ward | null => {
    const s = simplifyPoly(poly, front, 0.05, 2);
    if (s.poly.length < 3) return null;
    const c = centroid(s.poly);
    return {
      poly: s.poly,
      front: s.data,
      type,
      c,
      d: Math.hypot(c.x, c.y),
      inside: wallInside(c.x, c.y),
      coastal: s.poly.some((v) => coastAt(v.x, v.y) < 18),
      riverside: s.poly.some((v) => riverAt(v.x, v.y) < 18),
      bbox: bbox(s.poly),
      seed: (rand() * 4294967296) >>> 0,
      elev: elevAt(c.x, c.y),
    };
  };
  for (const f of faces) {
    const poly = f.nodes.map((id) => ({ x: g.nodes[id].x, y: g.nodes[id].y }));
    const front = f.edges.map((id) => g.edges[id].w);
    const c = centroid(poly);
    const u = urban(c.x, c.y);
    // Roads looping round open country enclose fields, not a block
    if (f.area > 250000 || (u < 0.15 && f.area > 15000) || land(c.x, c.y) < 4) continue;
    for (let k = 0; k < f.nodes.length; k++) inner.add(`${f.nodes[k]}>${f.nodes[(k + 1) % f.nodes.length]}`);
    // Very large blocks are cut by lanes
    const maxBlock = 26000 / density;
    for (const piece of f.area > maxBlock ? cutBlock(poly, front, maxBlock, 4.5, rand) : [{ poly, front }]) {
      const w = makeWard(piece.poly, piece.front, "residential");
      if (w) L.wards.push(w);
    }
  }
  // Roadside strips where streets run out into the country (and along dead ends)
  const facePolys = L.wards.map((w) => w.poly);
  for (const e of g.edges) {
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 24 || e.kind === "quay") continue;
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const u = urban(mid.x, mid.y);
    if (u < 0.3 || gone.has(g.edges.indexOf(e))) continue;
    for (const [P, Q, key] of [
      [A, B, `${e.a}>${e.b}`],
      [B, A, `${e.b}>${e.a}`],
    ] as const) {
      if (!e.dead && inner.has(key)) continue;
      const dx = (Q.x - P.x) / len;
      const dy = (Q.y - P.y) / len;
      // Left of P->Q (the side with no block)
      const nx = -dy;
      const ny = dx;
      const depth = (e.kind === "artery" ? 34 : 28) * (0.8 + 0.4 * u);
      const off = e.w / 2;
      const a = { x: P.x + dx * 5 + nx * off, y: P.y + dy * 5 + ny * off };
      const b = { x: Q.x - dx * 5 + nx * off, y: Q.y - dy * 5 + ny * off };
      const strip = [a, b, { x: b.x + nx * depth, y: b.y + ny * depth }, { x: a.x + nx * depth, y: a.y + ny * depth }];
      const sc = centroid(strip);
      if (strip.some((v) => land(v.x, v.y) < 4) || facePolys.some((fp) => pointInPoly(fp, sc.x, sc.y))) continue;
      // Front on the street edge only; the outline's own street is at its first edge
      const w = makeWard(strip, [0.01, 0, 0, 0], "suburb");
      if (w) {
        w.front = w.poly.map(() => 0);
        w.front[0] = 0.01; // lots face edge 0: the street runs just outside it
        L.wards.push(w);
      }
    }
  }
  yield;

  // ===================== Districts =====================
  const plaza = (w: Ward) => Math.abs(area(w.poly));
  const byDist = L.wards.filter((w) => w.front.some((f) => f > 0.5)).sort((a, b) => a.d - b.d);
  const take = (pred: (w: Ward) => boolean, type: WardType, score: (w: Ward) => number = () => rand()) => {
    const cands = L.wards.filter((w) => (w.type === "residential" || w.type === "suburb") && pred(w));
    if (!cands.length) return null;
    cands.sort((a, b) => score(b) - score(a));
    cands[0].type = type;
    return cands[0];
  };
  for (const w of L.wards) if (w.type === "residential" && (!w.inside || w.d > R * 1.05)) w.type = "suburb";
  if (city.size === 0 && city.population < 3000) {
    const green = byDist.find((w) => plaza(w) > 1500) ?? byDist[0];
    if (green) green.type = "green";
  } else {
    // The market square: the largest block close to the center, the busier its streets the better
    const near = byDist.filter((w) => w.d < Math.max(160, R * 0.22));
    const market = (near.length ? near : byDist.slice(0, 6)).sort(
      (a, b) => plaza(b) * (1 + b.front.filter((f) => f >= 7).length * 0.15) - plaza(a) * (1 + a.front.filter((f) => f >= 7).length * 0.15),
    )[0];
    if (market) market.type = "market";
    let castle: Ward | null = null;
    if (city.isCapital || city.population > 40000 || (city.population > 8000 && rand() < 0.55)) {
      // The highest, most defensible ground near the center (a promontory scores too)
      castle = take(
        (w) => w.d > R * 0.2 && w.d < R * 1.05 && plaza(w) > 3500,
        "castle",
        (w) => w.elev / 40 + (w.coastal ? 0.5 : 0) - w.d / R + rand() * 0.3,
      );
    }
    if (city.population > 12000) take((w) => w.inside && w.d < R * 0.5 && plaza(w) > 2500, "cathedral", (w) => -w.d + rand() * 60);
    if (city.isCapital && castle) take((w) => w.inside && Math.hypot(w.c.x - castle!.c.x, w.c.y - castle!.c.y) < 260 && plaza(w) > 4000, "palace");
    // Docks along the harbor's quay
    if (harbor) for (const w of L.wards) if ((w.type === "residential" || w.type === "suburb") && harbor.quay.some((q) => w.poly.some((v) => Math.hypot(v.x - q.x, v.y - q.y) < 45))) w.type = "harbor";
    const parks = city.population > 60000 ? 3 : city.population > 20000 ? 2 : city.population > 8000 ? 1 : 0;
    for (let i = 0; i < parks; i++) take((w) => w.d > R * 0.35 && w.d < Ru * 0.95 && plaza(w) > 6000, "park");
    if (city.population > 8000) take((w) => !w.inside && w.d > R * 0.7 && plaza(w) > 3000, "cemetery", (w) => w.d + rand() * 80);
    for (const w of L.wards) {
      if (w.type !== "residential") continue;
      if (w.riverside && rand() < 0.7) w.type = "craft";
      else {
        // Merchants build near the great buildings and on the heights
        const nearElite = L.wards.some(
          (o) => (o.type === "castle" || o.type === "cathedral" || o.type === "palace" || o.type === "market") && Math.hypot(o.c.x - w.c.x, o.c.y - w.c.y) < 220,
        );
        const high = w.elev > (market?.elev ?? 0) + 12;
        if ((nearElite && rand() < 0.5) || (high && rand() < 0.45)) w.type = "wealthy";
      }
    }
  }
  // Districts painted in the plan editor win
  for (const z of plan.zones ?? []) for (const w of L.wards) if (Math.hypot(w.c.x - z.x, w.c.y - z.y) <= z.r) w.type = z.type as WardType;
  yield;

  // ===================== Walls (finished) =====================
  if (wallPoly) {
    const towers: Vec[] = [];
    const segments: [Vec, Vec][] = [];
    for (let i = 0; i < wallPoly.length; i++) {
      const a = wallPoly[i];
      const b = wallPoly[(i + 1) % wallPoly.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Open along the water
      if (coastAt(mid.x, mid.y) < 6 || (wallShore[i] && wallShore[(i + 1) % wallPoly.length])) continue;
      segments.push([a, b]);
      if (!wallShore[i]) towers.push(a);
    }
    const gates: Vec[] = [];
    for (const art of L.arteries)
      for (let i = 0; i + 1 < art.pts.length; i++) {
        const p = art.pts[i];
        const q = art.pts[i + 1];
        if (pointInPoly(wallPoly, p.x, p.y) !== pointInPoly(wallPoly, q.x, q.y)) {
          gates.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
          break;
        }
      }
    L.wall = { poly: wallPoly, towers, gates, segments };
  }

  // ===================== Harbor =====================
  if (harbor) buildHarbor(L, harbor, rand, coastAt, land, seaward);
  // Stone embankments along the river in town
  for (const e of embankments) L.quays.push(e);

  // Bridges where main roads cross rivers
  for (const a of L.arteries) {
    let start = -1;
    for (let i = 0; i < a.pts.length; i++) {
      const wet = riverAt(a.pts[i].x, a.pts[i].y) < 0 && coastAt(a.pts[i].x, a.pts[i].y) > 0;
      if (wet && start < 0) start = Math.max(0, i - 1);
      if (!wet && start >= 0) {
        L.bridges.push({ a: a.pts[start], b: a.pts[i], width: a.width + 3 });
        start = -1;
      }
    }
  }
  yield;

  // ===================== Streets and obstacles =====================
  const obstacles = new SegmentHash();
  for (const [id, e] of g.edges.entries()) {
    if (gone.has(id)) continue;
    const a = { x: g.nodes[e.a].x, y: g.nodes[e.a].y };
    const b = { x: g.nodes[e.b].x, y: g.nodes[e.b].y };
    L.streets.push({ a, b, w: e.w, kind: e.kind });
    obstacles.add(a, b, e.w / 2 + 0.8);
  }
  if (L.wall) for (const [a, b] of L.wall.segments) obstacles.add(a, b, 6);
  for (const m of L.moles) for (let i = 0; i + 1 < m.length; i++) obstacles.add(m[i], m[i + 1], 6);

  // ===================== Farmland =====================
  // Fields only where all of them is dry, gentle, and outside the town
  const mask = new Uint8Array(an * an); // built-up, on the road grid
  for (const w of L.wards) {
    const [x0, y0, x1, y1] = w.bbox;
    for (let j = Math.max(0, Math.floor((y0 - origin) / ar)); j <= Math.min(an - 1, Math.ceil((y1 - origin) / ar)); j++)
      for (let i = Math.max(0, Math.floor((x0 - origin) / ar)); i <= Math.min(an - 1, Math.ceil((x1 - origin) / ar)); i++)
        if (pointInPoly(w.poly, origin + i * ar, origin + j * ar)) mask[j * an + i] = 1;
  }
  const builtUp = (x: number, y: number) => {
    const i = clamp(Math.round((x - origin) / ar), 0, an - 1);
    const j = clamp(Math.round((y - origin) / ar), 0, an - 1);
    return mask[j * an + i] === 1;
  };
  const fieldOk = (poly: Poly) => {
    const pts: Vec[] = [...poly, centroid(poly)];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 15; t < len; t += 15) pts.push({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
    }
    const [x0, y0, x1, y1] = bbox(poly);
    for (let y = y0 + 12; y < y1; y += 24) for (let x = x0 + 12; x < x1; x += 24) if (pointInPoly(poly, x, y)) pts.push({ x, y });
    return pts.every((v) => land(v.x, v.y) > 6 && !builtUp(v.x, v.y) && obstacles.clearance(v.x, v.y) > 1.5 && slopeAt(v.x, v.y).s < 0.2);
  };
  buildFarmland(L, world, rand, fieldOk, (x, y) => land(x, y) > 4 && obstacles.clearance(x, y) > 3 && !builtUp(x, y), obstacles);
  yield;

  // ===================== Labels =====================
  labelDistricts(L, rand);
  const streetNames = ["High Street", "Sultan's Road", "Market Street", "Bridge Street", "Castle Way", "Mill Lane", "Harbor Road", "Gate Street", "Mosque Street", "Old Road", "Caravan Way", "Smith Street", "Wool Street"];
  L.arteries.forEach((a, i) => {
    if (a.pts.length < 6) return;
    const k = Math.min(a.pts.length - 2, Math.max(1, Math.floor(a.pts.length * 0.18)));
    const p = a.pts[k];
    const q = a.pts[k + 1];
    let ang = Math.atan2(q.y - p.y, q.x - p.x);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    L.streetLabels.push({ text: streetNames[(i + Math.floor(rand() * 5)) % streetNames.length], x: p.x, y: p.y, angle: ang });
  });
  if (harbor && L.quays.length) L.streetLabels.push({ text: "The Quay", x: harbor.quay[harbor.quay.length >> 1].x, y: harbor.quay[harbor.quay.length >> 1].y, angle: 0 });

  internals.set(L, { obstacles });
  return L;
}

// Street pattern by the city's builders: planned grids for Latin and Eastern
// cities of size, winding streets elsewhere
function autoPattern(world: WorldData, city: City, roof: string): "organic" | "grid" | "radial" {
  void world;
  if (city.size >= 2 && roof === "hip" && city.seed % 3 === 0) return "grid";
  return "organic";
}

// A block too large for one: cut across its longest side, again and again,
// leaving a lane between the halves. Street widths follow each piece's edges.
function cutBlock(poly: Poly, front: number[], maxArea: number, lane: number, rand: () => number): { poly: Poly; front: number[] }[] {
  const out: { poly: Poly; front: number[] }[] = [];
  const widthOn = (a: Vec, b: Vec) => {
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (let i = 0; i < poly.length; i++) if (distToSegment(m.x, m.y, poly[i], poly[(i + 1) % poly.length]) < 0.6) return front[i];
    return lane;
  };
  const rec = (p: Poly, depth: number) => {
    const a = Math.abs(area(p));
    if (a <= maxArea || depth > 8 || p.length < 3) {
      if (a > 200) out.push({ poly: p, front: p.map((v, i) => widthOn(v, p[(i + 1) % p.length])) });
      return;
    }
    const e = longestEdge(p);
    const A = p[e.i];
    const t = 0.4 + 0.2 * rand();
    const o = { x: A.x + e.dir.x * e.len * t, y: A.y + e.dir.y * e.len * t };
    // The cut runs across the longest side
    const nx = e.dir.x;
    const ny = e.dir.y;
    const c = nx * o.x + ny * o.y;
    rec(clipHalfPlane(p, nx, ny, c), depth + 1);
    rec(clipHalfPlane(p, -nx, -ny, -c), depth + 1);
  };
  rec(poly, 0);
  return out;
}

// Quays, piers, a breakwater where the sea is open, cranes, a shipyard,
// ships moored and at anchor, and a lighthouse
function buildHarbor(
  L: CityLayout,
  h: { shore: Vec[]; quay: Vec[]; shelter: number; mid: Vec; out: Vec },
  rand: () => number,
  coastAt: (x: number, y: number) => number,
  land: (x: number, y: number) => number,
  seaward: (x: number, y: number) => Vec,
) {
  L.quays.push(h.shore);
  // The paved quayside between the waterfront and the quay street
  L.aprons.push([...h.shore, ...[...h.quay].reverse()]);
  // Piers into the harbor, every 45-70 m along the waterfront
  let acc = 0;
  for (let i = 1; i < h.shore.length; i++) {
    const p = h.shore[i];
    const q = h.shore[i - 1];
    acc += Math.hypot(p.x - q.x, p.y - q.y);
    if (acc < 45 + rand() * 25) continue;
    acc = 0;
    const nrm = seaward(p.x, p.y);
    let len = 35 + rand() * 60;
    for (let s = 8; s < len; s += 6)
      if (coastAt(p.x + nrm.x * s, p.y + nrm.y * s) > -3 || land(p.x + nrm.x * (s + 20), p.y + nrm.y * (s + 20)) > 0) {
        len = s - 8;
        break;
      }
    if (len < 22) continue;
    const wdt = 7 + rand() * 4;
    const a = Math.atan2(nrm.y, nrm.x);
    L.piers.push(rotRect(p.x + nrm.x * (len / 2 - 2), p.y + nrm.y * (len / 2 - 2), len + 4, wdt, a));
    // A crane at every other pier's root
    if (L.piers.length % 2 === 1) L.cranes.push(p.x - nrm.x * 6, p.y - nrm.y * 6, a);
    // Boats moored along it
    const boatsN = 1 + Math.floor(rand() * 3);
    for (let b = 0; b < boatsN; b++) {
      const along = 10 + rand() * (len - 14);
      const side = (rand() < 0.5 ? -1 : 1) * (wdt / 2 + 5 + rand() * 3);
      L.boats.push({ x: p.x + nrm.x * along - nrm.y * side, y: p.y + nrm.y * along + nrm.x * side, a: a + (rand() - 0.5) * 0.1, len: 12 + rand() * 20, sail: rand() < 0.45 });
    }
    if (L.piers.length > 40) break;
  }
  // A breakwater off the more exposed end where the harbor faces open sea
  if (h.shelter < 0.55 && h.shore.length > 6) {
    const end = h.shore[rand() < 0.5 ? 0 : h.shore.length - 1];
    const other = end === h.shore[0] ? h.shore[h.shore.length - 1] : h.shore[0];
    const nrm = seaward(end.x, end.y);
    const along = { x: other.x - end.x, y: other.y - end.y };
    const al = Math.hypot(along.x, along.y) || 1;
    const mole: Vec[] = [end];
    const out = 70 + rand() * 60;
    const span = al * (0.35 + rand() * 0.2);
    for (let s = 20; s <= out + span; s += 20) {
      const t = Math.min(1, s / out);
      const u = Math.max(0, s - out);
      const p = { x: end.x + nrm.x * out * t + (along.x / al) * u, y: end.y + nrm.y * out * t + (along.y / al) * u };
      if (coastAt(p.x, p.y) > -2) break;
      mole.push(p);
    }
    if (mole.length >= 3) {
      L.moles.push(mole);
      const tip = mole[mole.length - 1];
      L.landmarks.push({ kind: "lighthouse", polys: [], accents: [], circles: [tip.x, tip.y, 7, tip.x, tip.y, 3.5], stone: true });
    }
  }
  if (!L.moles.length && L.city.size >= 1) {
    // No breakwater: the lighthouse stands at the harbor's seaward end
    const tip = h.shore[0];
    const nrm = seaward(tip.x, tip.y);
    L.landmarks.push({ kind: "lighthouse", polys: [], accents: [], circles: [tip.x - nrm.x * 8, tip.y - nrm.y * 8, 7, tip.x - nrm.x * 8, tip.y - nrm.y * 8, 3.5], stone: true });
  }
  // A shipyard: slipways at the far end of the waterfront
  if (L.city.size >= 1) {
    const at = h.shore[Math.max(0, h.shore.length - 3)];
    const nrm = seaward(at.x, at.y);
    const a = Math.atan2(nrm.y, nrm.x);
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * 16;
      const cx = at.x + nrm.x * 12 - nrm.y * off;
      const cy = at.y + nrm.y * 12 + nrm.x * off;
      if (coastAt(cx + nrm.x * 20, cy + nrm.y * 20) < -2) L.slips.push(rotRect(cx, cy, 44, 9, a));
    }
  }
  // Ships at anchor in the harbor's water
  for (let i = 0; i < 10; i++) {
    const s = h.shore[Math.floor(rand() * h.shore.length)];
    const nrm = seaward(s.x, s.y);
    const r = 80 + rand() * 220;
    const x = s.x + nrm.x * r + (rand() - 0.5) * 60;
    const y = s.y + nrm.y * r + (rand() - 0.5) * 60;
    if (coastAt(x, y) < -40) L.boats.push({ x, y, a: rand() * Math.PI * 2, len: 24 + rand() * 22, sail: true });
  }
}

// Fields between lanes and hedgerows around the town: parcels split into
// rectangular fields and strips; pasture with copses toward the edge
function buildFarmland(
  L: CityLayout,
  world: WorldData,
  rand: () => number,
  fieldOk: (p: Poly) => boolean,
  pointOk: (x: number, y: number) => boolean,
  obstacles: SegmentHash,
) {
  const { city, R, Ru, Rf, style } = L;
  const cell = world.getCell(city.x, city.y);
  if (cell && (cell.biome === "Snow" || cell.biome === "Scorched" || cell.biome === "Bare")) return;
  const spacing = city.size === 0 ? 300 : 420;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const sites: Vec[] = [];
  const nP = Math.min(500, Math.round((Math.PI * Rf * Rf) / (spacing * spacing)));
  for (let i = 0; i < nP; i++) {
    const r = Rf * Math.sqrt((i + 0.5) / nP);
    if (r < R * 0.6) continue;
    const a = i * golden;
    sites.push({ x: Math.cos(a) * r + (rand() - 0.5) * spacing * 0.6, y: Math.sin(a) * r + (rand() - 0.5) * spacing * 0.6 });
  }
  const parcels = voronoi(sites, circlePoly(Rf, 56));
  let windmills = city.size >= 1 ? 2 + Math.floor(rand() * 3) : rand() < 0.5 ? 1 : 0;
  for (const poly of parcels) {
    if (poly.length < 3) continue;
    const c = centroid(poly);
    const d = Math.hypot(c.x, c.y);
    const alpha = 1 - Math.max(0, Math.min(1, (d - Rf * 0.7) / (Rf * 0.3)));
    const inset = insetConvex(poly, 4);
    if (!inset) continue;
    if (rand() < 0.15 + 0.35 * (d / Rf)) {
      // Pasture with a copse
      if (rand() < 0.5)
        for (let t = 0, n = 6 + Math.floor(rand() * 14); t < n; t++) {
          const x = c.x + (rand() - 0.5) * 60;
          const y = c.y + (rand() - 0.5) * 60;
          if (pointOk(x, y)) L.farmTrees.push(x, y, 3 + rand() * 3);
        }
      continue;
    }
    const blocks: Poly[] = [];
    subdivide(inset, 9000 + rand() * 22000, 3, rand, blocks);
    const parts: Poly[] = [];
    for (const blk of blocks) {
      if (rand() < 0.35) subdivide(blk, Math.abs(area(blk)) / (2 + Math.floor(rand() * 3)), 1.5, rand, parts);
      else parts.push(blk);
    }
    for (const part of parts) {
      if (Math.abs(area(part)) < 500 || !fieldOk(part)) continue;
      L.fields.push({ poly: part, color: Math.floor(rand() * style.fields.length), alpha });
      const roll = rand();
      if (roll < 0.06) {
        const bb = bbox(part);
        for (let y = bb[1] + 4; y < bb[3]; y += 9) for (let x = bb[0] + 4; x < bb[2]; x += 9) if (pointInPoly(part, x, y)) L.farmTrees.push(x, y, 3 + rand());
      } else if (roll < 0.3) {
        const e = longestEdge(part);
        const p0 = part[e.i];
        for (let t = 4; t < e.len; t += 9 + rand() * 8) L.farmTrees.push(p0.x + e.dir.x * t, p0.y + e.dir.y * t, 3 + rand() * 2.5);
      } else if (roll < 0.34 && alpha > 0.3) {
        const corner = part.reduce((b2, v) => (obstacles.clearance(v.x, v.y) < obstacles.clearance(b2.x, b2.y) ? v : b2));
        const cc = centroid(part);
        const dx = cc.x - corner.x;
        const dy = cc.y - corner.y;
        const dl = Math.hypot(dx, dy) || 1;
        const hx = corner.x + (dx / dl) * 18;
        const hy = corner.y + (dy / dl) * 18;
        const ang = Math.atan2(dy, dx);
        L.farmBuildings.push(rotRect(hx, hy, 16, 9, ang));
        L.farmBuildings.push(rotRect(hx + Math.cos(ang + 1.57) * 13, hy + Math.sin(ang + 1.57) * 13, 10, 7, ang));
      } else if (roll < 0.37 && windmills > 0 && d > Ru * 1.1) {
        windmills--;
        const cc = centroid(part);
        const lm: Landmark = { kind: "windmill", polys: [], accents: [], circles: [cc.x, cc.y, 5], stone: false };
        L.landmarks.push(lm);
      }
    }
  }
}

function labelDistricts(L: CityLayout, rand: () => number) {
  const groups = new Map<string, Ward[]>();
  for (const w of L.wards) {
    if (w.type === "residential") continue;
    const sector = ["harbor", "suburb", "craft", "wealthy"].includes(w.type) ? dirName(Math.atan2(w.c.y, w.c.x)) : "";
    const key = `${w.type}|${sector}`;
    const list = groups.get(key) ?? [];
    list.push(w);
    groups.set(key, list);
  }
  for (const [key, ws] of groups) {
    const [type, sector] = key.split("|") as [WardType, string];
    const names = TYPE_NAMES[type];
    if (!names) continue;
    // Small scraps of a district don't earn a name of their own
    if ((type === "suburb" || type === "wealthy" || type === "craft") && ws.length < 3) continue;
    let text = names[Math.floor(rand() * names.length)];
    if (type === "suburb") text = `${sector} ${text}`;
    else if (sector && ws.length < L.wards.length * 0.5) text = `${sector.split("-").pop()} ${text}`;
    if (type === "park" && ws.length === 1) text = `${L.city.name} ${text}`;
    const x = ws.reduce((s, w) => s + w.c.x, 0) / ws.length;
    const y = ws.reduce((s, w) => s + w.c.y, 0) / ws.length;
    L.labels.push({ text, x, y, size: Math.sqrt(ws.length) });
  }
  if (L.city.size >= 1) {
    const core = L.wards.filter((w) => w.type === "residential" && w.inside);
    if (core.length > 2) {
      const x = core.reduce((s, w) => s + w.c.x, 0) / core.length;
      const y = core.reduce((s, w) => s + w.c.y, 0) / core.length;
      L.labels.push({ text: "Old Quarter", x, y, size: 1.5 });
    }
  }
}
