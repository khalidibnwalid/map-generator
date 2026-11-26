import {
  type Poly,
  type Vec,
  area,
  centroid,
  circlePoly,
  insetPoly,
  longestEdge,
  pointInPoly,
  rayToPoly,
  rng,
} from "./geom";
import {
  type CityLayout,
  type RoofForm,
  type Ward,
  type WardDetail,
  type WardType,
  bbox,
  edgeDistance,
  internals,
  makeBuilding,
  mosque,
  rotRect,
  sampleField,
} from "./CityLayout";

// Plot by plot detail of one block, built when it first comes into view.
// Houses stand along the streets: each street side of the block is divided
// into narrow plots, the house at the front of its plot (terraced in the
// old town, detached with gardens in rich quarters and suburbs), yards and
// gardens behind; corner houses fill the street corners. Squares, castles,
// palaces, parks and cemeteries have layouts of their own.

interface Plots {
  front: [number, number]; // plot width along the street, m
  depth: number; // house depth, m
  setback: number; // distance from the street
  gap: number; // chance of a gap between neighbors (detached houses)
  empty: number; // chance a plot stays empty (a garden)
  garden: number; // chance of a tree behind each house
  big?: boolean; // halls and warehouses: hip roofs
}

const PLOTS: Partial<Record<WardType, Plots>> = {
  residential: { front: [5, 9], depth: 15, setback: 0, gap: 0.1, empty: 0.03, garden: 0.2 },
  wealthy: { front: [14, 24], depth: 14, setback: 4, gap: 0.85, empty: 0.06, garden: 0.8 },
  craft: { front: [10, 16], depth: 16, setback: 0, gap: 0.35, empty: 0.06, garden: 0.15 },
  harbor: { front: [18, 32], depth: 20, setback: 2, gap: 0.5, empty: 0.06, garden: 0.05, big: true },
  suburb: { front: [9, 15], depth: 10, setback: 3, gap: 0.8, empty: 0.25, garden: 0.5 },
  cathedral: { front: [7, 10], depth: 11, setback: 0, gap: 0.1, empty: 0.05, garden: 0.1 },
  green: { front: [10, 16], depth: 10, setback: 3, gap: 0.8, empty: 0.15, garden: 0.5 },
};

const emptyDetail = (): WardDetail => ({
  blocks: [],
  buildings: [],
  trees: [],
  plazas: [],
  paths: [],
  stalls: [],
  graves: [],
  ponds: [],
  hedges: [],
  landmarks: [],
  domes: [],
  minarets: [],
});

// Do two convex quads overlap? (separating axis test)
function overlaps(a: Poly, b: Poly): boolean {
  for (const p of [a, b])
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      const nx = q.y - p[i].y;
      const ny = p[i].x - q.x;
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (const v of a) {
        const d = v.x * nx + v.y * ny;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const v of b) {
        const d = v.x * nx + v.y * ny;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax <= bmin + 1e-6 || bmax <= amin + 1e-6) return false;
    }
  return true;
}

export function buildWardDetail(L: CityLayout, ward: Ward): WardDetail {
  const rand = rng(ward.seed);
  const st = L.style;
  const D = emptyDetail();
  const inner = internals.get(L);
  const land = (x: number, y: number) => sampleField(L, L.field, x, y);
  const clear = (x: number, y: number) => inner?.obstacles.clearance(x, y) ?? Infinity;
  const formFor = (): RoofForm => (st.roofForm === "mixed" ? (rand() < 0.45 ? "hip" : "gable") : st.roofForm);

  // The block's own ground: its outline pulled back from the streets around it
  // (an awkward outline that can't be pulled back evenly is pulled back a little, or not at all)
  const base =
    insetPoly(
      ward.poly,
      ward.front.map((f) => (f > 0.5 ? f / 2 + 0.6 : 0.6)),
    ) ??
    insetPoly(ward.poly, 2.5) ??
    (Math.abs(area(ward.poly)) > 60 ? ward.poly : null);
  if (!base) return D;
  const wc = centroid(base);
  const type = ward.type;

  // --- Open places with layouts of their own ---
  if (type === "park") {
    D.plazas.push(base);
    const b = bbox(base);
    for (let y = b[1]; y < b[3]; y += 11)
      for (let x = b[0]; x < b[2]; x += 11) {
        const px = x + (rand() - 0.5) * 8;
        const py = y + (rand() - 0.5) * 8;
        if (rand() < 0.55 && pointInPoly(base, px, py) && land(px, py) > 3) D.trees.push(px, py, 3 + rand() * 3.5);
      }
    // Paths crossing it between its corners
    const k = base.length;
    if (k >= 4) {
      D.paths.push([base[0], wc, base[Math.floor(k / 2)]]);
      D.paths.push([base[Math.floor(k / 4)], wc, base[Math.floor((3 * k) / 4)]]);
    }
    if (Math.abs(area(base)) > 20000) {
      const r = Math.sqrt(Math.abs(area(base))) * 0.11;
      D.ponds.push(circlePoly(r, 20).map((v) => ({ x: wc.x + v.x * 1.4 + r * 0.6, y: wc.y + v.y })));
    }
    return D;
  }
  if (type === "cemetery") {
    D.plazas.push(base);
    const yard = insetPoly(base, 2);
    if (yard) D.hedges.push(yard);
    const b = bbox(base);
    for (let y = b[1] + 4; y < b[3]; y += 3.2)
      for (let x = b[0] + 4; x < b[2]; x += 2.4)
        if (rand() < 0.7 && pointInPoly(base, x, y) && edgeDistance(base, x, y) > 4) D.graves.push(rotRect(x, y, 1, 2, 0));
    for (let i = 0; i < 12; i++) {
      const x = b[0] + rand() * (b[2] - b[0]);
      const y = b[1] + rand() * (b[3] - b[1]);
      if (pointInPoly(base, x, y)) D.trees.push(x, y, 3 + rand() * 2);
    }
    mosque(D, wc.x, wc.y, 14, 0, false);
    return D;
  }
  if (type === "castle") {
    // Curtain wall with towers round a courtyard, the keep in the middle
    const curtain = insetPoly(base, 6);
    if (curtain) {
      D.plazas.push(curtain);
      const e = longestEdge(curtain);
      const ang = Math.atan2(e.dir.y, e.dir.x);
      const size = Math.min(40, Math.sqrt(Math.abs(area(curtain))) * 0.45);
      const keep = rotRect(wc.x, wc.y, size, size * 0.78, ang);
      D.landmarks.push({ kind: "castle", polys: [curtain], accents: [], circles: curtain.flatMap((v) => [v.x, v.y, 7]), stone: true });
      D.landmarks.push({ kind: "keep", polys: [keep], accents: [], circles: keep.flatMap((v) => [v.x, v.y, 5]), stone: true });
    }
    return D;
  }
  if (type === "market") {
    // An open square: the town hall on one side, stalls (or a covered bazaar), a fountain
    D.plazas.push(base);
    D.landmarks.push({ kind: "fountain", polys: [], accents: [], circles: [wc.x, wc.y, 4], stone: true });
    const e = longestEdge(base);
    const ang = Math.atan2(e.dir.y, e.dir.x);
    const thAt = { x: wc.x + Math.cos(ang + 1.57) * 26, y: wc.y + Math.sin(ang + 1.57) * 26 };
    const th = rotRect(thAt.x, thAt.y, 30, 18, ang);
    if (pointInPoly(base, thAt.x, thAt.y)) D.landmarks.push({ kind: "townhall", polys: [th], accents: [], circles: [], stone: true });
    const b = bbox(base);
    if (st.bazaar) {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const ext = Math.max(b[2] - b[0], b[3] - b[1]);
      for (let u = -ext; u < ext; u += 8)
        for (let v = -ext; v < ext; v += 8) {
          if (Math.round(u / 8) % 6 === 0 || Math.round(v / 8) % 5 === 0) continue;
          const x = wc.x + u * c - v * s;
          const y = wc.y + u * s + v * c;
          if (!pointInPoly(base, x, y) || edgeDistance(base, x, y) < 14 || pointInPoly(th, x, y)) continue;
          D.stalls.push(rotRect(x, y, 6.2, 6.2, ang));
          if (rand() < 0.04) D.domes.push(x, y, 3.4);
        }
    } else {
      for (let i = 0; i < 80; i++) {
        const x = b[0] + rand() * (b[2] - b[0]);
        const y = b[1] + rand() * (b[3] - b[1]);
        if (!pointInPoly(base, x, y) || edgeDistance(base, x, y) < 10 || Math.hypot(x - wc.x, y - wc.y) < 9 || pointInPoly(th, x, y)) continue;
        D.stalls.push(rotRect(x, y, 3.5, 2.5, ang + (rand() < 0.5 ? 0 : 1.57)));
      }
    }
    return D;
  }
  if (type === "palace") {
    const e = longestEdge(base);
    const ang = Math.atan2(e.dir.y, e.dir.x);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const at = (u: number, v: number) => ({ x: wc.x + u * c - v * s, y: wc.y + u * s + v * c });
    const m = at(0, -25);
    const l = at(-38, 0);
    const r = at(38, 0);
    D.landmarks.push({
      kind: "palace",
      polys: [rotRect(m.x, m.y, 90, 20, ang), rotRect(l.x, l.y, 16, 60, ang), rotRect(r.x, r.y, 16, 60, ang)],
      accents: [],
      circles: [],
      stone: true,
    });
    const gd = at(0, 45);
    for (let k = 0; k < 3; k++) D.hedges.push(rotRect(gd.x, gd.y, 70 - k * 18, 50 - k * 14, ang));
    for (let k = -3; k <= 3; k++) {
      const p = at(k * 11, 80);
      D.trees.push(p.x, p.y, 3.5);
    }
    D.plazas.push(base);
    return D;
  }

  // --- Houses along the streets ---
  const P = PLOTS[type] ?? PLOTS.residential!;
  D.blocks.push(base);
  if (type === "green") {
    // A village green: the mosque and trees in the middle, houses round it
    mosque(D, wc.x, wc.y - 8, 16, (rand() - 0.5) * 0.3, false);
    for (let i = 0; i < 8; i++) D.trees.push(wc.x + (rand() - 0.5) * 40, wc.y + 10 + (rand() - 0.5) * 24, 3 + rand() * 3);
  }
  if (type === "cathedral") {
    // The great mosque on its square in the middle of the block
    D.plazas.push(insetPoly(base, 14) ?? base);
    mosque(D, wc.x, wc.y, L.city.population > 40000 ? 64 : 46, (rand() - 0.5) * 0.2, true);
  }
  const keepClear = (x: number, y: number) =>
    (type === "cathedral" && Math.hypot(x - wc.x, y - wc.y) < 52) || (type === "green" && Math.hypot(x - wc.x, y - wc.y) < 30);

  const placed: Poly[] = [];
  const free = (q: Poly) => !placed.some((o) => overlaps(o, q));
  const okHouse = (q: Poly) => {
    for (const v of q) {
      if (!pointInPoly(base, v.x, v.y) && edgeDistance(base, v.x, v.y) > 0.8) return false;
      // The block's ground already stands back from its streets: only other
      // streets (dead ends, lanes running into it) and walls are kept clear of
      if (land(v.x, v.y) < 1.5 || clear(v.x, v.y) < -0.6 || keepClear(v.x, v.y)) return false;
    }
    const c = centroid(q);
    return land(c.x, c.y) > 1.5 && free(q);
  };
  const wealthy = type === "wealthy";
  const pal = wealthy ? st.wealthyRoofs.length : st.roofs.length;
  const house = (q: Poly, big = false) => {
    const hip = P.big || big || Math.abs(area(q)) > 450;
    const form: RoofForm = st.roofForm === "flat" ? "flat" : hip ? "hip" : formFor();
    D.buildings.push(makeBuilding(q, Math.floor(rand() * pal), wealthy, form));
    placed.push(q);
    if (st.roofForm === "flat" && hip && rand() < 0.15) {
      const cc = centroid(q);
      D.domes.push(cc.x, cc.y, Math.sqrt(Math.abs(area(q))) * 0.22);
    }
  };

  // A row of houses along each marked side of `ring`, facing out of it,
  // and houses on its square corners. The street front of the block is the
  // first ring; old-town blocks get a second one round a courtyard.
  const rows = (ring: Poly, fronted: boolean[], R: Plots) => {
    let s2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      s2 += p.x * q.y - q.x * p.y;
    }
    const leftIn = s2 > 0; // inside on the left when the outline runs counter-clockwise
    const nb = ring.length;
    for (let i = 0; i < nb; i++) {
      if (!fronted[i]) continue;
      const A = ring[i];
      const B = ring[(i + 1) % nb];
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      if (len < R.front[0]) continue;
      const dx = (B.x - A.x) / len;
      const dy = (B.y - A.y) / len;
      const nx = leftIn ? -dy : dy;
      const ny = leftIn ? dx : -dx;
      // How deep the block is behind this side
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const room = rayToPoly(ring, mid.x + nx * 0.5, mid.y + ny * 0.5, nx, ny);
      const usable = Math.min(R.setback + R.depth * 1.25, room * 0.55);
      if (usable < R.setback + 5) continue;
      // Start where this row clears the row along the neighboring side: right
      // at the corner where the streets meet square or open, further in where
      // they meet at a sharp angle
      const clearOf = (V: Vec, W1: Vec, W2: Vec, near: boolean) => {
        if (!near) return 1;
        const a = { x: W1.x - V.x, y: W1.y - V.y };
        const b = { x: W2.x - V.x, y: W2.y - V.y };
        const la = Math.hypot(a.x, a.y) || 1;
        const lb = Math.hypot(b.x, b.y) || 1;
        const cos = (a.x * b.x + a.y * b.y) / (la * lb);
        const cross = a.x * b.y - a.y * b.x;
        const reflex = leftIn ? cross < 0 : cross > 0; // a corner turning into the block
        if (reflex) return 0.5;
        const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
        const d = Math.min(R.depth, usable);
        return Math.min(len * 0.45, 0.5 + (theta < Math.PI / 2 - 0.05 ? d / Math.tan(theta) : 0));
      };
      const m0 = clearOf(A, B, ring[(i - 1 + nb) % nb], fronted[(i - 1 + nb) % nb]);
      const m1 = clearOf(B, A, ring[(i + 2) % nb], fronted[(i + 1) % nb]);
      const terraced = rand() > R.gap;
      // A side too short for a full plot still gets one building
      const minFront = Math.min(R.front[0] * 0.6, Math.max(6, len - m0 - m1));
      for (let t = m0; t < len - m1 - 2; ) {
        let f = R.front[0] + rand() * (R.front[1] - R.front[0]);
        if (t + f > len - m1) f = len - m1 - t;
        if (f < minFront) break;
        const side = terraced ? 0.15 : 1 + rand() * 2;
        if (rand() >= R.empty) {
          const bd = Math.min(R.depth * (0.85 + 0.3 * rand()), usable - R.setback);
          const p0 = { x: A.x + dx * (t + side) + nx * R.setback, y: A.y + dy * (t + side) + ny * R.setback };
          const p1 = { x: A.x + dx * (t + f - side) + nx * R.setback, y: A.y + dy * (t + f - side) + ny * R.setback };
          const q: Poly = [p0, p1, { x: p1.x + nx * bd, y: p1.y + ny * bd }, { x: p0.x + nx * bd, y: p0.y + ny * bd }];
          if (bd > 4 && okHouse(q)) {
            house(q);
            // A tree in the yard behind
            if (rand() < R.garden) {
              const bk = R.setback + bd + 3 + rand() * 4;
              const tx = A.x + dx * (t + f / 2) + nx * bk;
              const ty = A.y + dy * (t + f / 2) + ny * bk;
              if (pointInPoly(ring, tx, ty) && land(tx, ty) > 3) D.trees.push(tx, ty, 2.5 + rand() * 2.5);
            }
          }
        } else if (rand() < 0.6) {
          const tx = A.x + dx * (t + f / 2) + nx * (R.setback + 5);
          const ty = A.y + dy * (t + f / 2) + ny * (R.setback + 5);
          if (pointInPoly(ring, tx, ty)) D.trees.push(tx, ty, 3 + rand() * 2);
        }
        t += f;
      }
    }
  };
  // Which sides of the base face a street (the inset keeps edge order unless an edge collapsed)
  const fronted = base.map((_v, i) => (base.length === ward.poly.length ? ward.front[i] > 0 : true));
  // In the old town plots are deeper: houses reach further back into the block
  const oldTown = (type === "residential" || type === "craft") && ward.d < L.R * 0.8;
  rows(base, fronted, oldTown ? { ...P, depth: P.depth * 1.3 } : P);
  // Gardens deep inside large blocks
  if (Math.abs(area(base)) > 2500) {
    const b = bbox(base);
    const want = wealthy || type === "suburb" ? 0.35 : 0.12;
    for (let y = b[1] + 6; y < b[3]; y += 12)
      for (let x = b[0] + 6; x < b[2]; x += 12) {
        const px = x + (rand() - 0.5) * 8;
        const py = y + (rand() - 0.5) * 8;
        if (rand() < want && pointInPoly(base, px, py) && edgeDistance(base, px, py) > P.setback + P.depth + 4 && land(px, py) > 3)
          D.trees.push(px, py, 2.5 + rand() * 3);
      }
  }
  // Now and then a neighborhood mosque in a large residential block
  if ((type === "residential" || type === "craft") && Math.abs(area(base)) > 6000 && rand() < 0.2) {
    const spot = { x: wc.x, y: wc.y };
    if (edgeDistance(base, spot.x, spot.y) > 18) mosque(D, spot.x, spot.y, 18, (rand() - 0.5) * 0.3, false);
  }
  return D;
}

export type { Vec };
