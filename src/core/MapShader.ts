import { COAST_GLSL } from "./FieldNoise";

export const VERTEX_SHADER_SOURCE = /* glsl */ `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Biome indices (see GPURenderer.prepareBiomeColors):
// 0 ocean, 1 shallow, 2 beach, 4 scorched, 5 bare, 6 tundra, 7 snow,
// 8 temperate desert, 9 shrubland, 10 grassland, 11 deciduous, 12 temperate rain,
// 13 subtropical desert, 14 tropical seasonal, 15 tropical rain, 19 taiga,
// 20 deep ocean, 21 marsh, 22 savanna, 23 steppe
export const FRAGMENT_SHADER_SOURCE = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_mapTexture;
uniform sampler2D u_coastTex;
uniform sampler2D u_nationsTexture;
uniform sampler2D u_provincesTexture;
uniform sampler2D u_thematicTex;
uniform sampler2D u_nationIdxTex;

uniform vec2 u_resolution;
uniform vec2 u_worldSize;
uniform ivec2 u_worldSizeI;
uniform uint u_seed;
uniform float u_scale;          // screen pixels per cell
uniform vec2 u_offsetLocal;     // screen offset of u_originI
uniform ivec2 u_originI;        // integer cell near the view centre, wrapped
uniform ivec2 u_fieldOriginI;   // integer part of rotated field lattice at origin
uniform vec2 u_fieldOriginF;    // fractional part of the same

uniform bool u_showBiomes;
uniform bool u_showElevation;
uniform bool u_showHeatmap;
uniform bool u_showPopulation;
uniform bool u_showMoisture;
uniform bool u_showNations;
uniform bool u_showBorders;
uniform bool u_showProvinces;
uniform int u_theme;            // 0 realistic, 1 historical, 2 atlas
uniform int u_thematic;         // 0 none, 1 cultures, 2 religions, 3 diplomacy

uniform vec3 u_biomeColors[40];
uniform float u_hoverNationIndex;
uniform vec3 u_hoverNationColor;
uniform bool u_showIce;
uniform float u_hoverProvinceIndex;

out vec4 fragColor;

${COAST_GLSL}

const float CELL_M = 5000.0;

int getBiome(float elevation, float temperature, float moisture) {
  if (elevation < 0.1) return 20;
  if (elevation < 0.3) return 0;
  if (elevation < 0.45) return 1;
  if (elevation < 0.48) return 2;
  if (elevation > 0.85) {
    if (moisture > 0.5) return 7;
    if (moisture > 0.33) return 6;
    if (moisture > 0.16) return 5;
    return 4;
  }
  if (elevation < 0.55 && moisture > 0.7) return 21;
  if (temperature > 0.66) {
    if (moisture > 0.66) return 15;
    if (moisture > 0.50) return 14;
    if (moisture > 0.33) return 22;
    if (moisture > 0.16) return 10;
    return 13;
  }
  if (temperature > 0.33) {
    if (moisture > 0.83) return 12;
    if (moisture > 0.50) return 11;
    if (moisture > 0.33) return 10;
    if (moisture > 0.16) return 23;
    return 8;
  }
  if (moisture > 0.80) return 7;
  if (moisture > 0.50) return 19;
  if (moisture > 0.33) return 9;
  return 6;
}

bool isForest(int b) { return b == 11 || b == 12 || b == 14 || b == 15 || b == 19 || b == 27 || b == 29 || b == 36; }
bool isArable(int b) { return b == 9 || b == 10 || b == 11 || b == 14 || b == 22 || b == 23 || b == 30 || b == 35; }

// Land biome from climate, relief and water (keep in sync with
// classifyLandBiome in WorldData.ts). slope: elevation change per cell;
// wd: distance to river/lake in cells; cd: distance to the sea in cells.
int classify(float e, float t, float m, float slope, float wd, float cd) {
  if (e > 0.86) return t < 0.25 ? 26 : (m > 0.45 ? 7 : 25);
  if (slope > 0.06 && e > 0.62) return 25;
  if (e > 0.78) {
    if (t < 0.2) return 26;
    return m > 0.3 ? 24 : 25;
  }
  if (e > 0.68) {
    if (t > 0.6 && m > 0.6) return 36;
    if (m > 0.4) return t < 0.35 ? 19 : 27;
    if (m > 0.2) return 9;
    return t > 0.55 ? 33 : 5;
  }
  if (wd < 0.35) {
    if (t < 0.3) return 31;
    if (m < 0.25) return 30;
    if (e < 0.53 && m > 0.55) return 21;
    return 30;
  }
  if (cd < 0.12 && t > 0.68 && m > 0.45 && e < 0.52) return 29;
  if (cd < 0.06 && m < 0.35 && e < 0.5) return 37;
  if (t > 0.66) {
    if (m < 0.08) return 37;
    if (m < 0.16) return (e < 0.5 && cd > 3.0) ? 32 : 13;
    if (m < 0.3) return e > 0.58 ? 33 : 22;
    if (m < 0.45) return 22;
    if (m < 0.62) return 14;
    return 15;
  }
  if (t > 0.33) {
    if (m < 0.12) return 34;
    if (m < 0.25) return (t > 0.5 && cd < 10.0) ? 28 : 23;
    if (m < 0.4) return t > 0.45 ? 35 : 10;
    if (e < 0.53 && m > 0.75) return 21;
    if (m < 0.8) return 11;
    return 12;
  }
  if (m < 0.2) return 6;
  if (m < 0.35) return 9;
  if (e < 0.52 && m > 0.7) return 31;
  return 19;
}

// Tree cover per biome: density (0..1) and leaf colour
float treeDensity(int b) {
  if (b == 15 || b == 36) return 0.9;
  if (b == 12 || b == 29) return 0.85;
  if (b == 11 || b == 14 || b == 19 || b == 27) return 0.72;
  if (b == 30) return 0.28;
  if (b == 21 || b == 31) return 0.14;
  if (b == 28) return 0.16;
  if (b == 22) return 0.06;
  if (b == 9) return 0.08;
  if (b == 10 || b == 35 || b == 24) return 0.025;
  return 0.0;
}
vec3 leafColor(int b) {
  if (b == 19 || b == 27) return vec3(0.12, 0.24, 0.15);   // conifers
  if (b == 15 || b == 36) return vec3(0.10, 0.30, 0.11);   // jungle
  if (b == 29) return vec3(0.16, 0.30, 0.16);              // mangrove
  if (b == 22 || b == 28) return vec3(0.33, 0.38, 0.18);   // acacia / scrub
  if (b == 14) return vec3(0.22, 0.36, 0.14);
  return vec3(0.19, 0.34, 0.15);                           // broadleaf
}

float decodeIdx(vec4 color) {
  return floor(color.r * 255.0 + 0.5) + floor(color.g * 255.0 + 0.5) * 256.0 + floor(color.b * 255.0 + 0.5) * 65536.0;
}

// Cheap float hash noise for low-frequency variation (precision is fine there)
float rand(vec2 co) { return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = rand(i);
  float b = rand(i + vec2(1.0, 0.0));
  float c = rand(i + vec2(0.0, 1.0));
  float d = rand(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}

vec4 fetchW(sampler2D t, ivec2 p) {
  p.x = (p.x + u_worldSizeI.x * 4) % u_worldSizeI.x;
  p.y = clamp(p.y, 0, u_worldSizeI.y - 1);
  return texelFetch(t, p, 0);
}

// Lattice coordinates at frequency f (lattice points per cell) for the split
// position (ci, l). Keeps precision for large f.
void lattice(ivec2 ci, vec2 l, float f, out ivec2 qi, out vec2 qf) {
  if (f >= 1.0) {
    int fi = int(f);
    vec2 q = l * f;
    vec2 fl = floor(q);
    qi = ci * fi + ivec2(fl);
    qf = q - fl;
  } else {
    vec2 q = (vec2(ci) + l) * f;
    vec2 fl = floor(q);
    qi = ivec2(fl);
    qf = q - fl;
  }
}

// Detail value noise at integer frequency f (only meaningful when f <= scale)
float detailNoise(ivec2 ci, vec2 l, int f, uint salt) {
  return valueNoise(ci, l, f, u_worldSizeI.x * f, u_seed ^ salt);
}

float getBorderStrength(vec4 c00, vec4 c10, vec4 c01, vec4 c11, vec2 fxy, float thickness, float aa) {
  float w00 = (1.0 - fxy.x) * (1.0 - fxy.y);
  float w10 = fxy.x * (1.0 - fxy.y);
  float w01 = (1.0 - fxy.x) * fxy.y;
  float w11 = fxy.x * fxy.y;
  vec2 g00 = vec2(fxy.y - 1.0, fxy.x - 1.0);
  vec2 g10 = vec2(1.0 - fxy.y, -fxy.x);
  vec2 g01 = vec2(-fxy.y, 1.0 - fxy.x);
  vec2 g11 = vec2(fxy.y, fxy.x);
  float s00 = w00; vec2 gs00 = g00;
  float s10 = w10; vec2 gs10 = g10;
  float s01 = w01; vec2 gs01 = g01;
  float s11 = w11; vec2 gs11 = g11;
  if (distance(c10, c00) < 0.001) { s00 += s10; gs00 += gs10; s10 = 0.0; }
  if (distance(c01, c00) < 0.001) { s00 += s01; gs00 += gs01; s01 = 0.0; }
  if (distance(c11, c00) < 0.001) { s00 += s11; gs00 += gs11; s11 = 0.0; }
  if (s10 > 0.0) {
    if (distance(c01, c10) < 0.001) { s10 += s01; gs10 += gs01; s01 = 0.0; }
    if (distance(c11, c10) < 0.001) { s10 += s11; gs10 += gs11; s11 = 0.0; }
  }
  if (s01 > 0.0) {
    if (distance(c11, c01) < 0.001) { s01 += s11; gs01 += gs11; s11 = 0.0; }
  }
  float m1 = s00; vec2 q1 = gs00;
  float m2 = 0.0; vec2 q2 = vec2(0.0);
  if (s10 > m1) { m2 = m1; q2 = q1; m1 = s10; q1 = gs10; } else if (s10 > m2) { m2 = s10; q2 = gs10; }
  if (s01 > m1) { m2 = m1; q2 = q1; m1 = s01; q1 = gs01; } else if (s01 > m2) { m2 = s01; q2 = gs01; }
  if (s11 > m1) { m2 = m1; q2 = q1; m1 = s11; q1 = gs11; } else if (s11 > m2) { m2 = s11; q2 = gs11; }
  vec2 grad = q1 - q2;
  float dist = (m1 - m2) / max(0.0001, length(grad));
  return smoothstep(thickness + aa * 0.5, thickness - aa * 0.5, dist);
}

// Which of the 4 texels owns this point, using the same merged-weight rule as
// getBorderStrength, so region fills meet exactly at the drawn border line.
ivec2 dominantCorner(vec4 c00, vec4 c10, vec4 c01, vec4 c11, vec2 fxy) {
  float w00 = (1.0 - fxy.x) * (1.0 - fxy.y);
  float w10 = fxy.x * (1.0 - fxy.y);
  float w01 = (1.0 - fxy.x) * fxy.y;
  float w11 = fxy.x * fxy.y;
  float s00 = w00 + (distance(c10, c00) < 0.001 ? w10 : 0.0) + (distance(c01, c00) < 0.001 ? w01 : 0.0) + (distance(c11, c00) < 0.001 ? w11 : 0.0);
  float s10 = w10 + (distance(c01, c10) < 0.001 ? w01 : 0.0) + (distance(c11, c10) < 0.001 ? w11 : 0.0) + (distance(c00, c10) < 0.001 ? w00 : 0.0);
  float s01 = w01 + (distance(c11, c01) < 0.001 ? w11 : 0.0) + (distance(c00, c01) < 0.001 ? w00 : 0.0) + (distance(c10, c01) < 0.001 ? w10 : 0.0);
  float s11 = w11 + (distance(c00, c11) < 0.001 ? w00 : 0.0) + (distance(c10, c11) < 0.001 ? w10 : 0.0) + (distance(c01, c11) < 0.001 ? w01 : 0.0);
  ivec2 best = ivec2(0, 0);
  float m = s00;
  if (s10 > m) { m = s10; best = ivec2(1, 0); }
  if (s01 > m) { m = s01; best = ivec2(0, 1); }
  if (s11 > m) { best = ivec2(1, 1); }
  return best;
}

// Procedural tree canopies on a 12.5 m lattice.
// Returns (coverage, light, shadow, crown texture).
vec4 trees(ivec2 ci, vec2 l, float density) {
  const int F = 400;
  vec2 q = l * float(F);
  vec2 fl = floor(q);
  vec2 qf = q - fl;
  int bx = ci.x * F + int(fl.x);
  int by = ci.y * F + int(fl.y);
  int per = u_worldSizeI.x * F;
  float pxPerLattice = u_scale / float(F);
  float best = 0.0;
  float light = 0.0;
  float shadow = 0.0;
  float tex = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      int cx = (bx + i + per * 4) % per;
      int cy = by + j;
      if (hashU(cx, cy, u_seed ^ 0x5bd1e995u) > density) continue;
      vec2 jit = vec2(hashU(cx, cy, u_seed + 11u), hashU(cx, cy, u_seed + 23u));
      vec2 c = vec2(float(i), float(j)) + 0.2 + 0.6 * jit;
      float h = hashU(cx, cy, u_seed + 37u);
      float r = 0.3 + 0.26 * h;
      vec2 d = (qf - c) / r;
      // Irregular, lobed crown outline
      float ang = atan(d.y, d.x);
      float lobes = 1.0 + 0.13 * sin(ang * 5.0 + h * 40.0) + 0.07 * sin(ang * 9.0 + h * 17.0);
      float dd = length(d) / lobes;
      float aa = 1.0 / max(0.5, r * pxPerLattice);
      float cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dd);
      // Shadow cast to the south-east
      vec2 ds = (qf - c - vec2(0.22, 0.22) * r) / r;
      float sh = 1.0 - smoothstep(0.9, 1.1, length(ds) / lobes);
      shadow = max(shadow, sh);
      if (cov > best) {
        best = cov;
        light = clamp(0.55 - 0.5 * (d.x + d.y) * 0.6, 0.0, 1.0) * (1.0 - 0.3 * dd);
        // Clumped foliage texture inside the crown
        tex = sin(d.x * 9.0 + h * 20.0) * sin(d.y * 9.0 - h * 13.0);
      }
    }
  }
  return vec4(best, light, shadow, tex);
}

// Patchwork of fields ~250 m across on a rotated lattice.
vec3 fieldPattern(vec2 l, vec3 base, out float edge) {
  const float A = 0.45;
  mat2 R = mat2(cos(A), sin(A), -sin(A), cos(A));
  vec2 q = u_fieldOriginF + R * l * 20.0;
  vec2 fl = floor(q);
  vec2 qf = q - fl;
  ivec2 id = u_fieldOriginI + ivec2(fl);
  float h = hashU(id.x, id.y, u_seed + 101u);
  // Split some fields into strips
  float strips = h < 0.5 ? floor(2.0 + 3.0 * hashU(id.x, id.y, u_seed + 7u)) : 1.0;
  float sx = qf.x * strips;
  float sid = floor(sx);
  float sf = fract(sx);
  float h2 = hashU(id.x * 7 + int(sid), id.y, u_seed + 202u);
  vec3 crops[5];
  crops[0] = vec3(0.56, 0.62, 0.30);
  crops[1] = vec3(0.74, 0.68, 0.38);
  crops[2] = vec3(0.47, 0.56, 0.27);
  crops[3] = vec3(0.60, 0.50, 0.34);
  crops[4] = vec3(0.68, 0.70, 0.40);
  vec3 crop = crops[int(h2 * 4.99)];
  float pxPerField = u_scale / 20.0;
  float e = min(min(qf.y, 1.0 - qf.y), min(sf / strips, (1.0 - sf) / strips));
  e = min(e, min(qf.x, 1.0 - qf.x));
  edge = 1.0 - smoothstep(0.0, 1.2 / max(1.0, pxPerField), e);
  // Furrows
  float furrow = 0.5 + 0.5 * sin(qf.y * 60.0 * (0.6 + h2));
  crop *= 0.94 + 0.06 * furrow * smoothstep(60.0, 200.0, pxPerField);
  return mix(base, crop, 0.75);
}

vec3 waterRealistic(float elevation, float coast, float lakeF, ivec2 ci, vec2 l) {
  float e = min(elevation, 0.449);
  float depth = clamp(e / 0.45, 0.0, 1.0);
  vec3 deepOcean = vec3(0.05, 0.15, 0.30);
  vec3 shallowOcean = vec3(0.10, 0.40, 0.60);
  vec3 c = mix(deepOcean, shallowOcean, depth);
  c += (fbm((vec2(ci) + l) * 0.05) - 0.5) * 0.05;
  // Continental shelf: progressively lighter toward the shore
  float shelfWide = smoothstep(-3.0, 0.0, coast);
  c = mix(c, vec3(0.14, 0.46, 0.62), shelfWide * 0.3);
  float shelf = smoothstep(-0.6, 0.0, coast);
  c = mix(c, vec3(0.20, 0.56, 0.66), shelf * 0.55);
  c = mix(c, vec3(0.20, 0.47, 0.58), 0.7 * lakeF);
  // Fine ripples once a cell spans many pixels
  if (u_scale > 200.0) {
    float r = detailNoise(ci, l, 256, 0x1234u) * 0.5 + detailNoise(ci, l, 1024, 0x2345u) * 0.25;
    c *= 1.0 + r * 0.06 * smoothstep(200.0, 800.0, u_scale);
  }
  return c;
}

void main() {
  vec2 sc = gl_FragCoord.xy;
  sc.y = u_resolution.y - sc.y;
  vec2 l = (sc - u_offsetLocal) / u_scale;
  ivec2 ci = u_originI;
  vec2 wxwy = vec2(ci) + l;

  float nx = wxwy.x / u_worldSize.x;
  nx = nx - floor(nx);
  float ny = clamp(wxwy.y / u_worldSize.y, 0.0, 1.0);

  vec4 data = texture(u_mapTexture, vec2(nx, ny));
  float elevation = data.r;
  float moisture = data.g;
  float temperature = data.b;
  float populationDensity = data.a;

  int octaves = clamp(int(floor(log2(max(u_scale, 1.0)))) + 1, 1, 11);
  float coast = coastField(ci, l, octaves);
  float px = 1.0 / u_scale; // cells per pixel
  float coastW = max(fwidth(coast), 1e-5);
  float landMask = smoothstep(-0.5, 0.5, coast / coastW);
  bool isLand = coast > 0.0;
  // Lake vs. sea, blended across texels so lake shores never show cell squares
  float lakeF;
  float waterD; // distance to river or lake, cells (0..8)
  {
    vec2 lp = l - 0.5;
    vec2 lfl = floor(lp);
    ivec2 lb = ci + ivec2(lfl);
    vec2 lw = lp - lfl;
    vec4 t00 = fetchW(u_coastTex, lb);
    vec4 t10 = fetchW(u_coastTex, lb + ivec2(1, 0));
    vec4 t01 = fetchW(u_coastTex, lb + ivec2(0, 1));
    vec4 t11 = fetchW(u_coastTex, lb + ivec2(1, 1));
    // b: 0 land, 0.5 ocean, 1 lake. Only water texels vote.
    vec4 isL = vec4(step(0.75, t00.b), step(0.75, t10.b), step(0.75, t01.b), step(0.75, t11.b));
    vec4 isW = vec4(step(0.25, t00.b), step(0.25, t10.b), step(0.25, t01.b), step(0.25, t11.b));
    vec4 wts = vec4((1.0 - lw.x) * (1.0 - lw.y), lw.x * (1.0 - lw.y), (1.0 - lw.x) * lw.y, lw.x * lw.y);
    float wsum = dot(isW, wts);
    lakeF = wsum > 0.0 ? dot(isL, wts) / wsum : (isL.x + isL.y + isL.z + isL.w > 0.0 ? 1.0 : 0.0);
    waterD = dot(vec4(t00.a, t10.a, t01.a, t11.a), wts) * 8.0;
  }
  bool lake = lakeF > 0.5;
  float coastLine = 1.0 - smoothstep(0.5, 1.5, abs(coast) / coastW);

  // Terrain shading
  float eps = 1.0 / u_worldSize.x;
  float hL = texture(u_mapTexture, vec2(nx - eps, ny)).r;
  float hR = texture(u_mapTexture, vec2(nx + eps, ny)).r;
  float hD = texture(u_mapTexture, vec2(nx, ny - eps)).r;
  float hU = texture(u_mapTexture, vec2(nx, ny + eps)).r;
  vec3 lightDir = normalize(vec3(-1.0, 1.0, 0.5));
  vec3 va = normalize(vec3(2.0 * eps, 0.0, hR - hL));
  vec3 vb = normalize(vec3(0.0, 2.0 * eps, hU - hD));
  float shade = 0.8 + 0.4 * dot(cross(va, vb), lightDir);

  float blendFactor = smoothstep(3.0, 8.0, u_scale);
  float e_noise = (fbm(wxwy * 1.5) - 0.5) * 0.05 * blendFactor;
  float t_noise = (fbm(wxwy * 1.5 + 10.0) - 0.5) * 0.15 * blendFactor;
  float m_noise = (fbm(wxwy * 1.5 + 20.0) - 0.5) * 0.15 * blendFactor;
  // Fine fractal detail so biome edges stay natural when zoomed in
  float fine = 0.0;
  if (u_scale > 16.0) fine += detailNoise(ci, l, 16, 0xb1u) * 0.5 * smoothstep(16.0, 40.0, u_scale);
  if (u_scale > 64.0) fine += detailNoise(ci, l, 64, 0xb2u) * 0.3 * smoothstep(64.0, 160.0, u_scale);
  if (u_scale > 256.0) fine += detailNoise(ci, l, 256, 0xb3u) * 0.2 * smoothstep(256.0, 640.0, u_scale);
  float qe = max(clamp(elevation + e_noise + fine * 0.012, 0.0, 1.0), 0.481);
  float qt = clamp(temperature + t_noise + fine * 0.04, 0.0, 1.0);
  float qm = clamp(moisture + m_noise + fine * 0.05, 0.0, 1.0);
  float slope = length(vec2(hR - hL, hU - hD)) * 0.5;
  float qw = waterD + fine * 0.35 + (fbm(wxwy * 4.0) - 0.5) * 0.3;
  int bIdx = classify(qe, qt, qm, slope, qw, coast);
  // A second, offset sample: where they disagree the two biomes interleave
  int bIdx2 = classify(qe - fine * 0.01, qt - fine * 0.03, qm - fine * 0.04, slope, qw + 0.15, coast);
  float detail = fbm(wxwy * 0.05);
  float ppm = u_scale / CELL_M; // pixels per meter

  vec3 color = vec3(0.0);
  float isletMask = 0.0; // cosmetic offshore islets count as land for overlays
  float iceMask = 0.0; // political tints fade over ice

  // ===================== BASE =====================
  if (u_showElevation) {
    color = isLand ? vec3(elevation) * shade : vec3(0.0, 0.0, elevation);
  } else if (u_theme == 1) {
    // ---- Historical: parchment & ink ----
    vec3 paper = vec3(0.93, 0.87, 0.72);
    float grain = fbm(wxwy * 3.0) * 0.6 + fbm(sc * 0.35) * 0.4;
    paper *= 0.93 + 0.1 * grain;
    if (isLand) {
      vec3 tint = u_biomeColors[bIdx];
      color = mix(paper, paper * (0.75 + 0.35 * tint), 0.35);
      color *= mix(1.0, shade, 0.55);
      color = mix(color, color * vec3(0.95, 0.88, 0.78), smoothstep(0.65, 0.9, elevation) * 0.6);
    } else {
      vec3 sea = mix(vec3(0.60, 0.70, 0.68), vec3(0.72, 0.79, 0.74), smoothstep(-2.0, 0.0, coast));
      color = mix(paper, sea, 0.85);
      // Concentric ripple lines hugging the coast
      float spacing = 5.0 * px;
      float k = -coast / spacing;
      if (k < 5.0) {
        float line = smoothstep(0.0, 1.0, 1.0 - abs(fract(k) - 0.5) * 2.0 * 4.0);
        color = mix(color, vec3(0.32, 0.42, 0.45), line * 0.35 * (1.0 - k / 5.0));
      }
    }
    // Glyph lattice ~14 px apart: mountains, hills, forests
    float fsym = exp2(floor(log2(max(u_scale / 14.0, 1.0 / 64.0))));
    ivec2 gq;
    vec2 gf;
    lattice(ci, l, fsym, gq, gf);
    vec2 centre = (vec2(gq) + 0.5) / fsym;
    vec2 cuv = vec2(fract(centre.x / u_worldSize.x), clamp(centre.y / u_worldSize.y, 0.0, 1.0));
    vec4 cd = texture(u_mapTexture, cuv);
    float jx = hashU(gq.x, gq.y, u_seed + 3u) - 0.5;
    vec2 g = gf - vec2(0.5 + jx * 0.3, 0.5);
    float pxPerSym = u_scale / fsym;
    float inkW = 1.1 / pxPerSym;
    vec3 ink = vec3(0.30, 0.22, 0.15);
    if (isLand && cd.r > 0.62 && coast > 2.0 / fsym) {
      float hgt = cd.r > 0.72 ? 0.42 : 0.24;
      // Peak glyph: two slopes meeting at the top
      vec2 p = g + vec2(0.0, 0.25);
      float left = abs(p.y + hgt + p.x * (hgt / 0.35)) / 1.5;
      float right = abs(p.y + hgt - p.x * (hgt / 0.35)) / 1.5;
      bool inX = abs(p.x) < 0.35 && p.y > -hgt && p.y < 0.02;
      float slope = p.x < 0.0 ? left : right;
      float stroke = inX ? 1.0 - smoothstep(inkW * 0.5, inkW * 1.5, slope) : 0.0;
      // Shaded east face
      bool inside = inX && p.y > -hgt + abs(p.x) * (hgt / 0.35);
      if (inside && p.x > 0.0) color = mix(color, ink, 0.18);
      color = mix(color, ink, stroke * 0.85);
    } else if (isLand && coast > 1.0 / fsym) {
      int cb = getBiome(max(cd.r, 0.481), cd.b, cd.g);
      if (isForest(cb)) {
        // Lollipop trees
        vec2 p = g * vec2(1.0, 1.0);
        float crown = length(p + vec2(0.0, 0.08)) - 0.17;
        float trunk = max(abs(p.x) - 0.015, abs(p.y - 0.14) - 0.08);
        float s = 1.0 - smoothstep(-inkW * 0.5, inkW * 0.5, min(abs(crown), trunk));
        if (crown < 0.0) color = mix(color, vec3(0.45, 0.52, 0.30), 0.35);
        color = mix(color, ink * vec3(0.9, 1.05, 0.85), s * 0.7);
      }
    }
    // Ink coastline
    color = mix(color, ink, coastLine * 0.9);
  } else if (u_theme == 2) {
    // ---- Atlas: clean political ----
    if (isLand) {
      color = vec3(0.95, 0.94, 0.90);
      color *= mix(1.0, shade, 0.4);
    } else {
      color = mix(vec3(0.62, 0.77, 0.89), vec3(0.80, 0.89, 0.95), smoothstep(-6.0, 0.0, coast));
      color = mix(color, vec3(0.74, 0.86, 0.94), lakeF);
    }
    color = mix(color, vec3(0.30, 0.48, 0.66), coastLine * 0.85);
  } else {
    // ---- Realistic ----
    if (isLand) {
      color = mix(u_biomeColors[bIdx], u_biomeColors[bIdx2], 0.5);
      color *= (0.85 + 0.3 * fbm(wxwy * 2.0));

      // Surface patterns for open landscapes
      if (bIdx == 37) {
        // Dune ridges (seif/barchan look), warped
        vec2 dir = normalize(vec2(1.0, 0.35));
        float ridge = sin(dot(wxwy, dir) * 9.0 + fbm(wxwy * 1.2) * 6.0);
        color *= 0.9 + 0.12 * smoothstep(-0.2, 1.0, ridge) * smoothstep(3.0, 10.0, u_scale);
      } else if (bIdx == 33) {
        // Layered strata in badlands
        float band = fract(elevation * 140.0 + fbm(wxwy * 0.8) * 0.6);
        color = mix(color, color * vec3(1.12, 0.9, 0.8), smoothstep(0.4, 0.6, band) * 0.5);
      } else if (bIdx == 32) {
        color = mix(color, vec3(0.95, 0.94, 0.9), 0.3 * fbm(wxwy * 6.0));
      } else if (bIdx == 26) {
        color = mix(color, vec3(0.85, 0.9, 0.96), 0.4 * smoothstep(0.45, 0.55, fbm(wxwy * 3.0)));
      } else if (bIdx == 15 || bIdx == 36 || bIdx == 29) {
        // Dense canopy mottling visible before individual trees appear
        float mot = fbm(wxwy * 8.0);
        color *= 0.8 + 0.35 * mot;
      }

      // Settled land reads slightly warmer/cleared (cities draw real fields)
      if (isArable(bIdx)) color = mix(color, color * vec3(1.06, 1.04, 0.9), smoothstep(0.35, 0.8, populationDensity) * 0.5);

      if (elevation > 0.7) {
        color = mix(color, vec3(0.4, 0.35, 0.3), (detail - 0.5) * 0.5);
        if (elevation > 0.85) {
          float snowBlend = smoothstep(0.85, 0.9, elevation + (detail - 0.5) * 0.2);
          color = mix(color, vec3(0.9, 0.9, 0.95), snowBlend);
        }
      } else {
        color = mix(color, color * (0.9 + 0.2 * detail), 0.4);
      }

      // Meter-scale ground texture when zoomed in
      if (u_scale > 64.0) {
        float g = 0.0;
        g += detailNoise(ci, l, 64, 0xa1u) * 0.5 * smoothstep(64.0, 128.0, u_scale);
        g += detailNoise(ci, l, 256, 0xa2u) * 0.3 * smoothstep(256.0, 512.0, u_scale);
        g += detailNoise(ci, l, 1024, 0xa3u) * 0.2 * smoothstep(1024.0, 2048.0, u_scale);
        color *= 1.0 + g * 0.12;
      }

      color *= shade;

      // Beaches on low coasts, rocky shores on high ones
      float beachW = max(0.035, 1.2 * px);
      float sand = 1.0 - smoothstep(0.0, beachW, coast);
      if (elevation < 0.56) color = mix(color, vec3(0.86, 0.80, 0.62) * shade, sand * 0.85);
      else color = mix(color, vec3(0.62, 0.58, 0.52) * shade, sand * 0.35);

      // Individual trees at high zoom
      if (ppm > 0.06) {
        float density = treeDensity(bIdx);
        if (density > 0.0) {
          vec4 t = trees(ci, l, density);
          float fade = smoothstep(0.06, 0.2, ppm);
          vec3 leaf = leafColor(bIdx);
          vec3 canopy = mix(leaf * 0.7, leaf * 1.45 + 0.03, t.y);
          canopy *= 1.0 + 0.08 * t.w * smoothstep(0.4, 1.5, ppm);
          color = mix(color, color * 0.62, t.z * (1.0 - t.x) * fade * 0.8);
          color = mix(color, canopy, t.x * fade);
        }
      }
    } else {
      color = waterRealistic(elevation, coast, lakeF, ci, l);
      // Offshore shoals and islets: the noisy shallows of the original look,
      // restricted to the sea side of the coast so they never form inland lakes.
      if (lakeF < 0.01 && coast > -1.2) {
        float shoalN = (fbm(wxwy * 0.5) - 0.5) * 0.06 + (fbm(wxwy * 3.0) - 0.5) * 0.03 * clamp(u_scale * 0.1, 0.0, 1.0);
        float shoal = smoothstep(0.43, 0.452, elevation + shoalN) * smoothstep(-1.2, -0.3, coast);
        color = mix(color, vec3(0.20, 0.55, 0.62), shoal * 0.6);
        // Islets only offshore, never as a fringe glued to the shoreline
        float islet = smoothstep(0.449, 0.455, elevation + shoalN * 1.4) * smoothstep(-0.9, -0.5, coast) * (1.0 - smoothstep(-0.3, -0.12, coast));
        color = mix(color, mix(vec3(0.83, 0.79, 0.62), u_biomeColors[bIdx] * shade, 0.45), islet);
        isletMask = islet;
      }
      float surf = 1.0 - smoothstep(0.0, max(0.006, 1.5 * px), -coast);
      color = mix(color, vec3(0.85, 0.92, 0.95), surf * 0.25 * smoothstep(20.0, 80.0, u_scale));
    }
  }

  // Antialias the shoreline: blend toward the other side's colour across the
  // one-pixel band where the coast field crosses zero.
  if (landMask > 0.001 && landMask < 0.999 && !u_showElevation) {
    vec3 other;
    if (u_theme == 1) {
      other = isLand ? vec3(0.66, 0.74, 0.70) : vec3(0.88, 0.82, 0.68);
      other = mix(other, vec3(0.30, 0.22, 0.15), 0.9); // ink line on the coast
    } else if (u_theme == 2) {
      other = isLand ? vec3(0.66, 0.80, 0.91) : vec3(0.94, 0.93, 0.89);
    } else {
      other = isLand ? waterRealistic(elevation, coast, lakeF, ci, l) : vec3(0.86, 0.80, 0.62) * shade;
    }
    float own = isLand ? landMask : 1.0 - landMask;
    color = mix(other, color, own);
  }

  // ===================== POLAR ICE =====================
  if (u_showIce && !u_showElevation) {
    // Caps follow latitude, as around the poles of a globe; the edge undulates
    // with low-frequency noise only, so it reads as a smooth ice margin.
    float lat = abs(wxwy.y / u_worldSize.y - 0.5) * 2.0;
    float wob = (fbm(vec2(wxwy.x * 0.012, lat * 3.0)) - 0.5) * 0.07 + (fbm(wxwy * 0.05) - 0.5) * 0.025;
    float seaEdge = 0.875 + wob;
    float landEdge = 0.80 + wob - max(0.0, elevation - 0.6) * 0.5;
    float px2lat = 2.0 / (u_worldSize.y * u_scale) * 1.5; // ~1.5 px soft edge
    if (!isLand) {
      float pack = smoothstep(seaEdge - 0.004 - px2lat, seaEdge + 0.004 + px2lat, lat);
      // Scattered floes in a belt just outside the pack edge
      float belt = smoothstep(seaEdge - 0.035, seaEdge, lat) * (1.0 - pack);
      float fl = fbm(wxwy * 0.9 + 3.0) * 0.65 + fbm(wxwy * 3.5) * 0.35;
      float floe = belt * smoothstep(0.6, 0.6 + 0.02 + 0.8 / max(1.0, u_scale), fl + belt * 0.12);
      // Sea ice reads as a light, translucent sea rather than opaque white
      vec3 seaIce = u_theme == 1 ? vec3(0.86, 0.90, 0.86) : u_theme == 2 ? vec3(0.86, 0.93, 0.98) : vec3(0.70, 0.86, 0.93);
      seaIce *= 0.98 + 0.02 * fbm(wxwy * 0.4);
      color = mix(color, mix(color, seaIce, 0.5), belt * 0.35);
      color = mix(color, seaIce, max(pack, floe) * 0.5);
      iceMask = max(pack, floe) * 0.5;
    } else {
      float sheet = smoothstep(landEdge - 0.004 - px2lat, landEdge + 0.004 + px2lat, lat);
      vec3 landIce = u_theme == 1 ? vec3(0.96, 0.95, 0.92) : vec3(0.97, 0.98, 1.0);
      landIce *= mix(1.0, shade, 0.35);
      color = mix(color, landIce, sheet * 0.7);
      iceMask = sheet * 0.7;
    }
  }

  // ===================== OVERLAYS =====================
  if (u_showHeatmap) color = mix(color, vec3(temperature, 0.0, 1.0 - temperature), 0.4);
  if (u_showMoisture) color = mix(color, vec3(1.0 - moisture, 1.0 - moisture, moisture), 0.4);
  if (u_showPopulation && isLand) {
    float p = populationDensity * populationDensity * (3.0 - 2.0 * populationDensity);
    vec3 popColor = mix(vec3(0.0, 0.2, 0.6), vec3(0.0, 0.8, 0.2), smoothstep(0.0, 0.3, p));
    popColor = mix(popColor, vec3(0.9, 0.9, 0.1), smoothstep(0.3, 0.6, p));
    popColor = mix(popColor, vec3(1.0, 0.1, 0.1), smoothstep(0.6, 0.85, p));
    popColor = mix(popColor, vec3(1.0, 1.0, 1.0), smoothstep(0.85, 1.0, p));
    color = mix(color, popColor, smoothstep(0.01, 0.9, p) * 0.85 * landMask);
  }

  // Cell lattice used by region overlays
  vec2 pos = l - 0.5;
  vec2 fl = floor(pos);
  ivec2 ixy = ci + ivec2(fl);
  vec2 fxy = pos - fl;
  float warp_f = (fbm(wxwy * 0.15) - 0.5) * 0.15;
  float warp_d = (fbm(wxwy * 1.5) - 0.5) * 0.05;
  vec2 noisy_fxy = clamp(fxy + warp_f + warp_d, 0.0, 1.0);
  float field_per_pixel = 1.0 / max(0.01, u_scale);
  float zoomVisibility = clamp(1.6 / pow(u_scale, 0.4), 1.0, 2.5);
  float aa = 1.2 * field_per_pixel;
  // Political fill fades out as you zoom into city scale
  float politicalFade = 1.0 - smoothstep(30.0, 250.0, u_scale) * 0.85;

  // --- Thematic (cultures / religions / diplomacy) ---
  if (u_thematic > 0) {
    vec4 t00 = fetchW(u_thematicTex, ixy);
    vec4 t10 = fetchW(u_thematicTex, ixy + ivec2(1, 0));
    vec4 t01 = fetchW(u_thematicTex, ixy + ivec2(0, 1));
    vec4 t11 = fetchW(u_thematicTex, ixy + ivec2(1, 1));
    vec4 tc = fetchW(u_thematicTex, ixy + dominantCorner(t00, t10, t01, t11, noisy_fxy));
    float a = tc.a * landMask * politicalFade;
    if (u_thematic == 3 && tc.a > 0.9) {
      // Focus nation in diplomacy view: diagonal hatching
      float hatch = step(0.5, fract((sc.x + sc.y) / 7.0));
      color = mix(color, tc.rgb, a * (0.45 + 0.25 * hatch));
    } else {
      color = mix(color, tc.rgb, a * 0.55);
    }
    float tb = getBorderStrength(t00, t10, t01, t11, noisy_fxy, 0.6 * field_per_pixel * zoomVisibility, aa);
    color = mix(color, vec3(0.12), tb * 0.5 * landMask);
  }

  // --- Nations fill (land strong, territorial waters faint) ---
  if (u_showNations && u_thematic == 0) {
    vec4 c00 = fetchW(u_nationIdxTex, ixy);
    vec4 c10 = fetchW(u_nationIdxTex, ixy + ivec2(1, 0));
    vec4 c01 = fetchW(u_nationIdxTex, ixy + ivec2(0, 1));
    vec4 c11 = fetchW(u_nationIdxTex, ixy + ivec2(1, 1));
    ivec2 ownerTexel = ixy + dominantCorner(c00, c10, c01, c11, noisy_fxy);
    vec4 nationColor = fetchW(u_nationsTexture, ownerTexel);
    vec4 ownerIdx = fetchW(u_nationIdxTex, ownerTexel);
    if (nationColor.a > 0.1) {
      bool hovered = u_hoverNationIndex >= 0.0 && abs(decodeIdx(ownerIdx) - u_hoverNationIndex) < 0.5;
      vec3 nc = nationColor.rgb;
      // Province patchwork: tiny brightness shift per province
      if (u_showProvinces) {
        // Bilinear blend of per-province brightness avoids blocky texel edges
        float b00 = 0.93 + 0.14 * rand(vec2(decodeIdx(fetchW(u_provincesTexture, ixy)), 7.1));
        float b10 = 0.93 + 0.14 * rand(vec2(decodeIdx(fetchW(u_provincesTexture, ixy + ivec2(1, 0))), 7.1));
        float b01 = 0.93 + 0.14 * rand(vec2(decodeIdx(fetchW(u_provincesTexture, ixy + ivec2(0, 1))), 7.1));
        float b11 = 0.93 + 0.14 * rand(vec2(decodeIdx(fetchW(u_provincesTexture, ixy + ivec2(1, 1))), 7.1));
        vec2 sw = smoothstep(0.25, 0.75, noisy_fxy);
        nc *= mix(mix(b00, b10, sw.x), mix(b01, b11, sw.x), sw.y);
      }
      float landA = u_theme == 2 ? 0.88 : (u_theme == 1 ? 0.22 : 0.4);
      if (u_theme == 2) {
        // Pastel fill that keeps the relief, plus a saturated ribbon inside borders
        vec3 pastel = mix(nc, vec3(1.0), 0.5) * mix(1.0, shade, 0.35);
        float rib = getBorderStrength(c00, c10, c01, c11, noisy_fxy, 3.0 * field_per_pixel, aa * 2.0);
        nc = mix(pastel, nc * 0.95, rib * 0.7);
      }
      float lm = max(landMask, isletMask);
      float alpha = landA * lm * politicalFade * (1.0 - 0.75 * iceMask);
      if (u_theme == 1) {
        // Vintage ribbon: strong colour wash just inside each border
        float rib = getBorderStrength(c00, c10, c01, c11, noisy_fxy, 4.0 * field_per_pixel, aa * 3.0);
        alpha += rib * 0.4 * landMask;
      }
      if (hovered) color = mix(color, nc + vec3(0.2), min(1.0, alpha * 1.6));
      else color = mix(color, nc, alpha);
    }
    // Sea claims stay plain water; hovering a nation reveals its waters, with
    // ownership blended smoothly between texels (no cell squares)
    if (u_hoverNationIndex >= 0.0) {
      vec4 hv = vec4(
        step(abs(decodeIdx(c00) - u_hoverNationIndex), 0.5) * c00.a,
        step(abs(decodeIdx(c10) - u_hoverNationIndex), 0.5) * c10.a,
        step(abs(decodeIdx(c01) - u_hoverNationIndex), 0.5) * c01.a,
        step(abs(decodeIdx(c11) - u_hoverNationIndex), 0.5) * c11.a);
      vec2 hs = smoothstep(0.0, 1.0, noisy_fxy);
      float hw = mix(mix(hv.x, hv.y, hs.x), mix(hv.z, hv.w, hs.x), hs.y);
      float seaA = 0.18 * smoothstep(0.35, 0.65, hw) * (1.0 - max(landMask, isletMask)) * politicalFade;
      color = mix(color, u_hoverNationColor, seaA);
    }
  }

  // --- Borders ---
  float natBorderStrength = 0.0;
  if (u_showBorders) {
    vec4 n00 = fetchW(u_nationIdxTex, ixy);
    vec4 n10 = fetchW(u_nationIdxTex, ixy + ivec2(1, 0));
    vec4 n01 = fetchW(u_nationIdxTex, ixy + ivec2(0, 1));
    vec4 n11 = fetchW(u_nationIdxTex, ixy + ivec2(1, 1));
    float thickness = 1.2 * field_per_pixel * zoomVisibility;
    natBorderStrength = getBorderStrength(n00, n10, n01, n11, noisy_fxy, thickness, aa);
    if (natBorderStrength > 0.01) {
      vec3 bc = u_theme == 1 ? vec3(0.55, 0.12, 0.10) : (u_theme == 2 ? vec3(0.25) : vec3(1.0));
      float landPart = natBorderStrength * 0.8 * landMask;
      // Maritime limits only for the hovered nation, thin and dashed
      float seaPart = 0.0;
      if (u_hoverNationIndex >= 0.0) {
        float own = max(max(step(abs(decodeIdx(n00) - u_hoverNationIndex), 0.5) * n00.a, step(abs(decodeIdx(n10) - u_hoverNationIndex), 0.5) * n10.a),
                        max(step(abs(decodeIdx(n01) - u_hoverNationIndex), 0.5) * n01.a, step(abs(decodeIdx(n11) - u_hoverNationIndex), 0.5) * n11.a));
        float dash = step(0.45, fract((sc.x + sc.y) / 9.0));
        seaPart = getBorderStrength(n00, n10, n01, n11, noisy_fxy, thickness * 0.45, aa) * 0.45 * dash * own * (1.0 - landMask);
      }
      if (u_theme == 1) landPart *= step(0.3, fract((wxwy.x - wxwy.y) * (u_scale / 7.0)));
      color = mix(color, bc, landPart + seaPart);
    }
  }

  if (u_showProvinces) {
    vec4 p00 = fetchW(u_provincesTexture, ixy);
    vec4 p10 = fetchW(u_provincesTexture, ixy + ivec2(1, 0));
    vec4 p01 = fetchW(u_provincesTexture, ixy + ivec2(0, 1));
    vec4 p11 = fetchW(u_provincesTexture, ixy + ivec2(1, 1));
    float thickness = 0.5 * field_per_pixel * zoomVisibility;
    float provBorderStrength = getBorderStrength(p00, p10, p01, p11, noisy_fxy, thickness, aa);
    provBorderStrength *= (1.0 - natBorderStrength) * landMask;
    if (provBorderStrength > 0.01) {
      float dash = step(0.4, fract((wxwy.x + wxwy.y) * 1.5 * max(1.0, u_scale / 6.0)));
      vec3 pcol = u_theme == 1 ? vec3(0.42, 0.28, 0.18) : vec3(0.0);
      color = mix(color, pcol, provBorderStrength * 0.4 * (0.6 + 0.4 * dash));
    }
    if (u_hoverProvinceIndex >= 0.0) {
      float h00 = step(abs(decodeIdx(p00) - u_hoverProvinceIndex), 0.5) * p00.a;
      float h10 = step(abs(decodeIdx(p10) - u_hoverProvinceIndex), 0.5) * p10.a;
      float h01 = step(abs(decodeIdx(p01) - u_hoverProvinceIndex), 0.5) * p01.a;
      float h11 = step(abs(decodeIdx(p11) - u_hoverProvinceIndex), 0.5) * p11.a;
      float hw = mix(mix(h00, h10, noisy_fxy.x), mix(h01, h11, noisy_fxy.x), noisy_fxy.y);
      color += vec3(0.2) * landMask * hw;
    }
  }

  if (u_theme == 1) {
    // Aged-paper vignette
    vec2 uv = sc / u_resolution - 0.5;
    color *= 1.0 - 0.35 * smoothstep(0.35, 0.75, length(uv));
  }

  fragColor = vec4(color, 1.0);
}
`;
