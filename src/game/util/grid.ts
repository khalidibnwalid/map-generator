// Grid helpers shared by the generators. All flat arrays are indexed y * W + x
// and wrap horizontally (the world is a cylinder).

export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  public size = 0;

  constructor(capacity: number = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  public clear() {
    this.size = 0;
  }

  public push(key: number, val: number) {
    if (this.size >= this.keys.length) {
      const nk = new Float64Array(this.keys.length * 2);
      nk.set(this.keys);
      const nv = new Int32Array(this.vals.length * 2);
      nv.set(this.vals);
      this.keys = nk;
      this.vals = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  public peekKey(): number {
    return this.keys[0];
  }

  // Returns the value with the smallest key. Caller must check size > 0.
  public pop(): number {
    const top = this.vals[0];
    const lastK = this.keys[--this.size];
    const lastV = this.vals[this.size];
    let i = 0;
    const n = this.size;
    while (true) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastK) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = lastK;
    this.vals[i] = lastV;
    return top;
  }
}

const INF = 1e20;

function dt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  arg: Int32Array,
  v: Int32Array,
  z: Float64Array,
) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] >= INF) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -INF;
      z[1] = INF;
      continue;
    }
    let s =
      (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  if (k < 0) {
    for (let q = 0; q < n; q++) {
      d[q] = INF;
      arg[q] = -1;
    }
    return;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const dq = q - v[j];
    d[q] = dq * dq + f[v[j]];
    arg[q] = v[j];
  }
}

// Exact Euclidean distance transform (Felzenszwalb) with horizontal wrap.
// Returns distance (in cells) from every cell to the nearest site and that
// site's flat index (-1 when there are no sites).
export function distanceTransform(
  W: number,
  H: number,
  isSite: Uint8Array,
): { dist: Float32Array; nearest: Int32Array } {
  const N = W * H;
  const colD = new Float64Array(N);
  const colArg = new Int32Array(N);
  const maxN = Math.max(H, 2 * W) + 2;
  const f = new Float64Array(maxN);
  const d = new Float64Array(maxN);
  const arg = new Int32Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = isSite[y * W + x] ? 0 : INF;
    dt1d(f, H, d, arg, v, z);
    for (let y = 0; y < H; y++) {
      colD[y * W + x] = d[y];
      colArg[y * W + x] = arg[y];
    }
  }

  const dist = new Float32Array(N);
  const nearest = new Int32Array(N);
  const L = 2 * W;
  const half = W >> 1;
  for (let y = 0; y < H; y++) {
    for (let i = 0; i < L; i++) {
      const x = (((i - half) % W) + W) % W;
      f[i] = colD[y * W + x];
    }
    dt1d(f, L, d, arg, v, z);
    for (let i = half; i < half + W; i++) {
      const x = (((i - half) % W) + W) % W;
      const idx = y * W + x;
      if (arg[i] < 0 || d[i] >= INF) {
        dist[idx] = INF;
        nearest[idx] = -1;
      } else {
        const sx = (((arg[i] - half) % W) + W) % W;
        const sy = colArg[y * W + sx];
        dist[idx] = Math.sqrt(d[i]);
        nearest[idx] = sy * W + sx;
      }
    }
  }
  return { dist, nearest };
}

// Connected component labeling (4-neighbor, horizontal wrap).
export function labelComponents(
  W: number,
  H: number,
  mask: Uint8Array,
): { labels: Int32Array; sizes: number[] } {
  const N = W * H;
  const labels = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!mask[s] || labels[s] >= 0) continue;
    const id = sizes.length;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = id;
    let count = 0;
    while (sp > 0) {
      const c = stack[--sp];
      count++;
      const x = c % W;
      const y = (c - x) / W;
      const nb = [
        y * W + ((x + 1) % W),
        y * W + ((x - 1 + W) % W),
        y > 0 ? c - W : -1,
        y < H - 1 ? c + W : -1,
      ];
      for (const n of nb) {
        if (n >= 0 && mask[n] && labels[n] < 0) {
          labels[n] = id;
          stack[sp++] = n;
        }
      }
    }
    sizes.push(count);
  }
  return { labels, sizes };
}

export function wrapDx(dx: number, W: number): number {
  if (dx > W / 2) return dx - W;
  if (dx < -W / 2) return dx + W;
  return dx;
}

// Chaikin corner cutting; keeps both endpoints. `vals` are carried along.
export function chaikin(
  pts: { x: number; y: number }[],
  vals: number[],
  iterations: number,
): { pts: { x: number; y: number }[]; vals: number[] } {
  let P = pts;
  let V = vals;
  for (let it = 0; it < iterations; it++) {
    if (P.length < 3) break;
    const NP: { x: number; y: number }[] = [P[0]];
    const NV: number[] = [V[0]];
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i];
      const b = P[i + 1];
      NP.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      NP.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
      NV.push(0.75 * V[i] + 0.25 * V[i + 1]);
      NV.push(0.25 * V[i] + 0.75 * V[i + 1]);
    }
    NP.push(P[P.length - 1]);
    NV.push(V[V.length - 1]);
    P = NP;
    V = NV;
  }
  return { pts: P, vals: V };
}

// Cooperative yield for long generation loops: keeps working for ~40 ms, then
// gives the browser a turn (to paint progress) via a macrotask. Cheaper than
// awaiting a full animation frame on every call.
let lastYield = 0;
export async function yieldFrame(force = false): Promise<void> {
  const now = performance.now();
  if (!force && now - lastYield < 40) return;
  // MessageChannel tasks are not throttled in background tabs (setTimeout is)
  await new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
  lastYield = performance.now();
}
