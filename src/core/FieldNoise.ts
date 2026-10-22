// Deterministic integer-hash value noise shared by the CPU and the GPU.
//
// The coastline is rendered by the fragment shader, but city generation needs
// to know exactly where that coastline is (so buildings never end up in the
// sea). Both sides therefore evaluate the same function: the TS code below and
// the GLSL in COAST_GLSL must be kept in lock-step.
//
// Positions are split into an integer cell + a small local offset so that the
// GPU keeps meter-level precision even when zoomed far into a large map.

export const CELL_METERS = 5000;

// Signed distance to the coast is stored in 16 bits over [-SDF_RANGE, SDF_RANGE] cells.
export const SDF_RANGE = 32;
export const COAST_OCTAVES = 11; // frequencies 1..1024 per cell (5 km .. ~5 m)
export const COAST_AMP = 0.2; // cells
const COAST_PERSISTENCE = 0.45;
export const COAST_NOISE_BAND = 2 * COAST_AMP + 0.05;

export function hashU(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function octaveSeed(seed: number, k: number): number {
  return (seed + Math.imul(k + 1, 0x9e3779b9)) >>> 0;
}

// One octave of value noise in [-1, 1] at integer frequency f (lattice points per cell).
export function valueNoise(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  f: number,
  periodX: number,
  seed: number,
): number {
  const qx = lx * f;
  const qy = ly * f;
  const qix = Math.floor(qx);
  const qiy = Math.floor(qy);
  const fx = qx - qix;
  const fy = qy - qiy;
  const ix = (cx * f + qix + periodX * 4) % periodX;
  const ix1 = (ix + 1) % periodX;
  const iy = cy * f + qiy;
  const a = hashU(ix, iy, seed);
  const b = hashU(ix1, iy, seed);
  const c = hashU(ix, iy + 1, seed);
  const d = hashU(ix1, iy + 1, seed);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return (top + (bot - top) * uy) * 2 - 1;
}

export function coastNoise(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  worldW: number,
  seed: number,
  octaves: number = COAST_OCTAVES,
): number {
  let sum = 0;
  let amp = COAST_AMP;
  for (let k = 0; k < octaves; k++) {
    const f = 1 << k;
    sum += amp * valueNoise(cx, cy, lx, ly, f, worldW * f, octaveSeed(seed, k));
    amp *= COAST_PERSISTENCE;
  }
  return sum;
}

// Smoothly fades the coast noise to zero at the edge of its band.
export function coastTaper(s: number): number {
  const t = Math.max(0, Math.min(1, (Math.abs(s) - (COAST_NOISE_BAND - 0.2)) / 0.2));
  return 1 - t * t * (3 - 2 * t);
}

export function decodeSdf(q: number): number {
  return (q / 65535) * 2 * SDF_RANGE - SDF_RANGE;
}

export function encodeSdf(d: number): number {
  const c = Math.max(-SDF_RANGE, Math.min(SDF_RANGE, d));
  return Math.round(((c + SDF_RANGE) / (2 * SDF_RANGE)) * 65535);
}

// GLSL ES 3.00 twin of the functions above. Requires uniforms:
//   usampler-free: u_coastTex (RGBA8, NEAREST), u_worldSizeI (ivec2), u_seed (uint)
export const COAST_GLSL = /* glsl */ `
float hashU(int x, int y, uint seed) {
  uint h = (uint(x) * 0x27d4eb2du) ^ (uint(y) * 0x165667b1u) ^ seed;
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  return float(h) / 4294967296.0;
}

uint octaveSeed(uint seed, int k) {
  return seed + uint(k + 1) * 0x9e3779b9u;
}

float valueNoise(ivec2 ci, vec2 l, int f, int periodX, uint seed) {
  vec2 q = l * float(f);
  vec2 qi = floor(q);
  vec2 qf = q - qi;
  int ix = (ci.x * f + int(qi.x) + periodX * 4) % periodX;
  int ix1 = (ix + 1) % periodX;
  int iy = ci.y * f + int(qi.y);
  float a = hashU(ix, iy, seed);
  float b = hashU(ix1, iy, seed);
  float c = hashU(ix, iy + 1, seed);
  float d = hashU(ix1, iy + 1, seed);
  vec2 u = qf * qf * (3.0 - 2.0 * qf);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

float coastNoise(ivec2 ci, vec2 l, int octaves) {
  float sum = 0.0;
  float amp = ${COAST_AMP.toFixed(4)};
  for (int k = 0; k < ${COAST_OCTAVES}; k++) {
    if (k >= octaves) break;
    int f = 1 << k;
    sum += amp * valueNoise(ci, l, f, u_worldSizeI.x * f, octaveSeed(u_seed, k));
    amp *= ${COAST_PERSISTENCE.toFixed(3)};
  }
  return sum;
}

float sdfTexel(int tx, int ty) {
  tx = (tx + u_worldSizeI.x * 4) % u_worldSizeI.x;
  ty = clamp(ty, 0, u_worldSizeI.y - 1);
  vec4 t = texelFetch(u_coastTex, ivec2(tx, ty), 0);
  float q = floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5);
  return q / 65535.0 * ${(2 * SDF_RANGE).toFixed(1)} - ${SDF_RANGE.toFixed(1)};
}

float coastTaper(float s) {
  float t = clamp((abs(s) - ${(COAST_NOISE_BAND - 0.2).toFixed(3)}) / 0.2, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

float coastSdf(ivec2 ci, vec2 l) {
  vec2 t = l - 0.5;
  vec2 tf = floor(t);
  vec2 w = t - tf;
  int tx = ci.x + int(tf.x);
  int ty = ci.y + int(tf.y);
  float a = sdfTexel(tx, ty);
  float b = sdfTexel(tx + 1, ty);
  float c = sdfTexel(tx, ty + 1);
  float d = sdfTexel(tx + 1, ty + 1);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// Signed coast field in cells: > 0 land, < 0 water. The noise fades out
// smoothly towards the band edge so the field stays continuous.
float coastField(ivec2 ci, vec2 l, int octaves) {
  float s = coastSdf(ci, l);
  if (abs(s) > ${COAST_NOISE_BAND.toFixed(3)}) return s;
  return s + coastNoise(ci, l, octaves) * coastTaper(s);
}
`;
