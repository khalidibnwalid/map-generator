import { segIntersect, distToSegment, type Vec } from "./geom";

// The street network of a city plan: a planar graph in local meters. Streets
// are added a segment at a time with `extend`, which keeps the graph planar:
// a new segment stops where it first crosses an existing street (splitting
// it into a junction), snaps onto a node or street close to its end, and is
// refused when it would leave a junction at too sharp an angle. Blocks are
// the faces of the graph once dead ends are set aside (`faces`).

export type StreetKind = "artery" | "street" | "lane" | "quay";

export interface StreetNode {
  x: number;
  y: number;
  e: number[]; // edge ids
}

export interface StreetEdge {
  a: number;
  b: number;
  w: number; // width, meters
  kind: StreetKind;
  dead: boolean; // a dead end (set by pruneDeadEnds): drawn, but bounds no block
}

export interface Face {
  nodes: number[]; // around the block, inside on the left
  edges: number[]; // edges[i] runs from nodes[i] to nodes[i+1]
  area: number; // m², positive
}

const MIN_ANGLE = 0.38; // ~22°: sharper junctions are refused

export class StreetGraph {
  nodes: StreetNode[] = [];
  edges: StreetEdge[] = [];
  private eg = new Map<number, number[]>(); // grid cell -> edge ids
  private ng = new Map<number, number[]>(); // grid cell -> node ids
  private cs: number;

  constructor(cell = 40) {
    this.cs = cell;
  }

  private key(cx: number, cy: number) {
    return (cy + 8192) * 16384 + (cx + 8192);
  }

  addNode(x: number, y: number): number {
    const id = this.nodes.length;
    this.nodes.push({ x, y, e: [] });
    const k = this.key(Math.floor(x / this.cs), Math.floor(y / this.cs));
    (this.ng.get(k) ?? this.ng.set(k, []).get(k)!).push(id);
    return id;
  }

  private indexEdge(id: number) {
    const e = this.edges[id];
    const A = this.nodes[e.a];
    const B = this.nodes[e.b];
    const x0 = Math.floor(Math.min(A.x, B.x) / this.cs);
    const x1 = Math.floor(Math.max(A.x, B.x) / this.cs);
    const y0 = Math.floor(Math.min(A.y, B.y) / this.cs);
    const y1 = Math.floor(Math.max(A.y, B.y) / this.cs);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = this.key(x, y);
        (this.eg.get(k) ?? this.eg.set(k, []).get(k)!).push(id);
      }
  }

  // Edges whose grid cells meet the box around a-b (padded by `pad`)
  private edgesNear(a: Vec, b: Vec, pad: number): Set<number> {
    const out = new Set<number>();
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / this.cs);
    const x1 = Math.floor((Math.max(a.x, b.x) + pad) / this.cs);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / this.cs);
    const y1 = Math.floor((Math.max(a.y, b.y) + pad) / this.cs);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) for (const id of this.eg.get(this.key(x, y)) ?? []) out.add(id);
    return out;
  }

  nearNode(x: number, y: number, r: number, skip?: (id: number) => boolean): number {
    let best = -1;
    let bd = r;
    const x0 = Math.floor((x - r) / this.cs);
    const x1 = Math.floor((x + r) / this.cs);
    const y0 = Math.floor((y - r) / this.cs);
    const y1 = Math.floor((y + r) / this.cs);
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++)
        for (const id of this.ng.get(this.key(cx, cy)) ?? []) {
          if (skip?.(id)) continue;
          const n = this.nodes[id];
          const d = Math.hypot(n.x - x, n.y - y);
          if (d < bd) {
            bd = d;
            best = id;
          }
        }
    return best;
  }

  neighbors(n: number): number[] {
    return this.nodes[n].e.map((id) => (this.edges[id].a === n ? this.edges[id].b : this.edges[id].a));
  }

  link(a: number, b: number, w: number, kind: StreetKind): number {
    if (a === b || this.neighbors(a).includes(b)) return -1;
    const id = this.edges.length;
    this.edges.push({ a, b, w, kind, dead: false });
    this.nodes[a].e.push(id);
    this.nodes[b].e.push(id);
    this.indexEdge(id);
    return id;
  }

  // A junction at (x, y) on edge `id`: the edge ends there, a new one carries on
  splitEdge(id: number, x: number, y: number): number {
    const e = this.edges[id];
    const n = this.addNode(x, y);
    const b = e.b;
    // The old edge now runs a -> n
    this.nodes[b].e = this.nodes[b].e.filter((k) => k !== id);
    e.b = n;
    this.nodes[n].e.push(id);
    this.indexEdge(id);
    const id2 = this.edges.length;
    this.edges.push({ a: n, b, w: e.w, kind: e.kind, dead: false });
    this.nodes[n].e.push(id2);
    this.nodes[b].e.push(id2);
    this.indexEdge(id2);
    return n;
  }

  // Would a street from n toward (x, y) leave n at a fair angle?
  private angleOk(n: number, x: number, y: number): boolean {
    const N = this.nodes[n];
    const a = Math.atan2(y - N.y, x - N.x);
    for (const m of this.neighbors(n)) {
      const M = this.nodes[m];
      let d = Math.abs(Math.atan2(M.y - N.y, M.x - N.x) - a);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < MIN_ANGLE) return false;
    }
    return true;
  }

  // The first existing street a segment from node `a` to `to` crosses
  private firstCrossing(a: number, to: Vec, ignore: (id: number) => boolean): { t: number; id: number } | null {
    const A = this.nodes[a];
    let best: { t: number; id: number } | null = null;
    for (const id of this.edgesNear(A, to, 1)) {
      const e = this.edges[id];
      if (e.a === a || e.b === a || ignore(id)) continue;
      const r = segIntersect(A, to, this.nodes[e.a], this.nodes[e.b]);
      if (r && r.t > 1e-6 && (!best || r.t < best.t)) best = { t: r.t, id };
    }
    return best;
  }

  // Lays a street from node `a` toward `p`. Returns the node it reached and
  // whether that joined existing streets, or null when refused (too short,
  // too sharp, or it would run into a street at a bad angle).
  extend(a: number, p: Vec, w: number, kind: StreetKind, snap: number): { node: number; hit: boolean } | null {
    const A = this.nodes[a];
    const minLen = Math.max(4, snap * 0.4);
    const cross = this.firstCrossing(a, p, () => false);
    if (cross) {
      const e = this.edges[cross.id];
      const X = { x: A.x + (p.x - A.x) * cross.t, y: A.y + (p.y - A.y) * cross.t };
      if (Math.hypot(X.x - A.x, X.y - A.y) < minLen) return null;
      const EA = this.nodes[e.a];
      const EB = this.nodes[e.b];
      let target: number;
      if (Math.hypot(X.x - EA.x, X.y - EA.y) < snap) target = e.a;
      else if (Math.hypot(X.x - EB.x, X.y - EB.y) < snap) target = e.b;
      else {
        if (!this.angleOk(a, X.x, X.y)) return null;
        target = this.splitEdge(cross.id, X.x, X.y);
        this.link(a, target, w, kind);
        return { node: target, hit: true };
      }
      const T = this.nodes[target];
      if (!this.angleOk(a, T.x, T.y) || !this.angleOk(target, A.x, A.y)) return null;
      if (this.firstCrossing(a, T, (id) => this.edges[id].a === target || this.edges[id].b === target)) return null;
      this.link(a, target, w, kind);
      return { node: target, hit: true };
    }
    // Close to an existing junction: join it
    const near = this.neighbors(a);
    const n = this.nearNode(p.x, p.y, snap, (id) => id === a || near.includes(id));
    if (n >= 0) {
      const N = this.nodes[n];
      if (this.angleOk(a, N.x, N.y) && this.angleOk(n, A.x, A.y) && !this.firstCrossing(a, N, (id) => this.edges[id].a === n || this.edges[id].b === n)) {
        this.link(a, n, w, kind);
        return { node: n, hit: true };
      }
    }
    // Close to an existing street: meet it square on
    let bestE = -1;
    let bd = snap * 0.7;
    for (const id of this.edgesNear(p, p, snap)) {
      const e = this.edges[id];
      if (e.a === a || e.b === a) continue;
      const d = distToSegment(p.x, p.y, this.nodes[e.a], this.nodes[e.b]);
      if (d < bd) {
        bd = d;
        bestE = id;
      }
    }
    if (bestE >= 0) {
      const e = this.edges[bestE];
      const EA = this.nodes[e.a];
      const EB = this.nodes[e.b];
      const dx = EB.x - EA.x;
      const dy = EB.y - EA.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - EA.x) * dx + (p.y - EA.y) * dy) / l2));
      const X = { x: EA.x + dx * t, y: EA.y + dy * t };
      if (t > 0.05 && t < 0.95 && Math.hypot(X.x - A.x, X.y - A.y) >= minLen && this.angleOk(a, X.x, X.y) && !this.firstCrossing(a, X, (id) => id === bestE)) {
        const m = this.splitEdge(bestE, X.x, X.y);
        this.link(a, m, w, kind);
        return { node: m, hit: true };
      }
    }
    if (Math.hypot(p.x - A.x, p.y - A.y) < minLen || !this.angleOk(a, p.x, p.y)) return null;
    const m = this.addNode(p.x, p.y);
    this.link(a, m, w, kind);
    return { node: m, hit: false };
  }

  // Lays a whole polyline (an artery, a quay), starting from an existing
  // node when one is close to its first point. Returns its nodes in order.
  addPolyline(pts: Vec[], w: number, kind: StreetKind, snap: number): number[] {
    if (pts.length < 2) return [];
    let cur = this.nearNode(pts[0].x, pts[0].y, snap);
    if (cur < 0) cur = this.nodeOnStreet(pts[0], snap * 0.5);
    if (cur < 0) cur = this.addNode(pts[0].x, pts[0].y);
    const out = [cur];
    for (let i = 1; i < pts.length; i++) {
      // Junctions met on the way are walked through: keep heading for the next point
      for (let guard = 0; guard < 8; guard++) {
        const r = this.extend(cur, pts[i], w, kind, i === pts.length - 1 ? snap : snap * 0.5);
        if (!r) break;
        cur = r.node;
        out.push(cur);
        const N = this.nodes[cur];
        if (Math.hypot(N.x - pts[i].x, N.y - pts[i].y) < snap) break;
      }
    }
    return out;
  }

  // A junction where `p` lies on an existing street (within `tol`), or -1
  nodeOnStreet(p: Vec, tol: number): number {
    for (const id of this.edgesNear(p, p, tol)) {
      const e = this.edges[id];
      const A = this.nodes[e.a];
      const B = this.nodes[e.b];
      if (distToSegment(p.x, p.y, A, B) > tol) continue;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / (dx * dx + dy * dy || 1);
      if (t <= 0.02) return e.a;
      if (t >= 0.98) return e.b;
      return this.splitEdge(id, A.x + dx * t, A.y + dy * t);
    }
    return -1;
  }

  degree(n: number): number {
    let d = 0;
    for (const id of this.nodes[n].e) if (!this.edges[id].dead) d++;
    return d;
  }

  // Dead ends (and the spurs leading to them) bound no block: mark them
  pruneDeadEnds() {
    const stack: number[] = [];
    for (let n = 0; n < this.nodes.length; n++) if (this.degree(n) === 1) stack.push(n);
    while (stack.length) {
      const n = stack.pop()!;
      if (this.degree(n) !== 1) continue;
      const id = this.nodes[n].e.find((k) => !this.edges[k].dead)!;
      const e = this.edges[id];
      e.dead = true;
      const m = e.a === n ? e.b : e.a;
      if (this.degree(m) === 1) stack.push(m);
    }
  }

  // The blocks: faces of the graph without its dead ends, each traced with
  // the inside on the left. The unbounded outer face of every piece of the
  // network is left out (it runs the other way round).
  faces(): Face[] {
    const N = this.nodes;
    // Neighbors of each node by angle
    const around = N.map((n, i) =>
      n.e
        .filter((id) => !this.edges[id].dead)
        .map((id) => {
          const e = this.edges[id];
          const m = e.a === i ? e.b : e.a;
          return { m, id, ang: Math.atan2(N[m].y - n.y, N[m].x - n.x) };
        })
        .sort((p, q) => p.ang - q.ang),
    );
    const used = new Set<string>();
    const out: Face[] = [];
    for (let u0 = 0; u0 < N.length; u0++)
      for (const { m: v0, id: e0 } of around[u0]) {
        if (used.has(`${u0}>${v0}`)) continue;
        const nodes: number[] = [];
        const edges: number[] = [];
        let u = u0;
        let v = v0;
        let id = e0;
        for (let guard = 0; guard < 4000; guard++) {
          used.add(`${u}>${v}`);
          nodes.push(u);
          edges.push(id);
          // Next: the street at v turning most sharply left from where we came
          const list = around[v];
          const i = list.findIndex((o) => o.m === u && o.id === id);
          const next = list[(i - 1 + list.length) % list.length];
          u = v;
          v = next.m;
          id = next.id;
          if (u === u0 && v === v0) break;
        }
        // Signed area (standard orientation): faces on the left come out positive
        let a = 0;
        for (let k = 0; k < nodes.length; k++) {
          const p = N[nodes[k]];
          const q = N[nodes[(k + 1) % nodes.length]];
          a += p.x * q.y - q.x * p.y;
        }
        a /= 2;
        if (a > 1) out.push({ nodes, edges, area: a });
      }
    return out;
  }
}
