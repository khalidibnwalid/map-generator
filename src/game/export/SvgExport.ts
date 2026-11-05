import { BIOME_COLORS, type Point, type WorldData } from "../WorldData";
import type { RasterImage } from "./GameExport";

// A layered SVG of the whole world for vector editors (Inkscape, Illustrator,
// Affinity). Terrain and realm colors are embedded pictures; borders, rivers,
// roads, sea lanes, settlements and labels are editable vectors, each in its
// own layer. Units are grid cells (viewBox = width x height).

const INK = 'inkscape:groupmode="layer"';
const r2 = (v: number) => Math.round(v * 100) / 100;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hexRgb = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const v = m ? parseInt(m[1], 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// Biome colors with relief shading lit from the north-west
export function terrainImage(world: WorldData): RasterImage {
  const W = world.width;
  const H = world.height;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const e = (x: number, y: number) => world.grid[(x + W) % W][Math.max(0, Math.min(H - 1, y))].elevation;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = world.grid[x][y];
      const [r, g, b] = hexRgb(BIOME_COLORS[c.biome] ?? "#808080");
      const s = c.isWater ? 1 : Math.max(0.6, Math.min(1.35, 1 + (e(x - 1, y - 1) - e(x + 1, y + 1)) * 9));
      const o = (y * W + x) * 4;
      rgba[o] = r * s;
      rgba[o + 1] = g * s;
      rgba[o + 2] = b * s;
      rgba[o + 3] = 255;
    }
  return { name: "terrain", width: W, height: H, rgba };
}

// Realm colors on land, transparent elsewhere
export function realmsImage(world: WorldData): RasterImage {
  const W = world.width;
  const H = world.height;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const colors = world.nations.map((n) => hexRgb(n.color));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = world.grid[x][y];
      const col = colors[c.nationIndex ?? -1];
      if (c.isWater || !col) continue;
      const o = (y * W + x) * 4;
      rgba[o] = col[0];
      rgba[o + 1] = col[1];
      rgba[o + 2] = col[2];
      rgba[o + 3] = 255;
    }
  return { name: "realms", width: W, height: H, rgba };
}

// Cell edges between land of different owners, chained into polylines
export function traceBorders(world: WorldData): Point[][] {
  const W = world.width;
  const H = world.height;
  const owner = (x: number, y: number) => {
    const c = world.grid[(x + W) % W][y];
    return c.isWater ? -2 : (c.nationIndex ?? -1);
  };
  // Segments keyed by their end vertices (vertex id = y * (W + 1) + x)
  const V = W + 1;
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push(b);
    let m = adj.get(b);
    if (!m) adj.set(b, (m = []));
    m.push(a);
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = owner(x, y);
      if (o === -2) continue;
      // East edge (the seam column keeps its own vertices at x = W)
      const e = owner(x + 1, y);
      if (e !== -2 && e !== o) link(y * V + x + 1, (y + 1) * V + x + 1);
      if (y + 1 < H) {
        const s = owner(x, y + 1);
        if (s !== -2 && s !== o) link((y + 1) * V + x, (y + 1) * V + x + 1);
      }
    }
  const used = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const toPt = (v: number): Point => ({ x: v % V, y: Math.floor(v / V) });
  const lines: Point[][] = [];
  const walk = (start: number, next: number) => {
    const line = [start, next];
    used.add(key(start, next));
    let prev = start;
    let cur = next;
    // Continue through vertices where exactly two edges meet
    for (;;) {
      const nb = adj.get(cur)!;
      if (nb.length !== 2) break;
      const n = nb[0] === prev ? nb[1] : nb[0];
      if (used.has(key(cur, n))) break;
      used.add(key(cur, n));
      line.push(n);
      prev = cur;
      cur = n;
    }
    lines.push(line.map(toPt));
  };
  // Open chains start at junctions and ends; what remains are closed loops
  for (const [v, nb] of adj) if (nb.length !== 2) for (const n of nb) if (!used.has(key(v, n))) walk(v, n);
  for (const [v, nb] of adj) for (const n of nb) if (!used.has(key(v, n))) walk(v, n);
  return lines;
}

// Rounds off the cell staircase, keeping the ends where borders meet
export function smooth(p: Point[], passes = 2): Point[] {
  // Edge midpoints first: a cell staircase becomes a diagonal
  let pts = p.length < 3 ? p : [p[0], ...p.slice(0, -1).map((a, i) => ({ x: (a.x + p[i + 1].x) / 2, y: (a.y + p[i + 1].y) / 2 })), p[p.length - 1]];
  for (let k = 0; k < passes; k++) {
    if (pts.length < 3) return pts;
    const out: Point[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

const pathD = (p: Point[]) => "M" + p.map((q) => `${r2(q.x)} ${r2(q.y)}`).join("L");

// A polyline, repeated one world-width over where it runs across the seam
function polyline(p: Point[], W: number, attrs: string): string {
  if (p.length < 2) return "";
  const d = pathD(p);
  let out = `<path d="${d}" ${attrs}/>`;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const q of p) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
  }
  if (maxX > W) out += `<path d="${d}" transform="translate(${-W} 0)" ${attrs}/>`;
  if (minX < 0) out += `<path d="${d}" transform="translate(${W} 0)" ${attrs}/>`;
  return out;
}

export interface SvgImages {
  terrain: string; // PNG data URLs
  realms: string;
}

export function buildSvg(world: WorldData, images: SvgImages, title = "World"): string {
  const W = world.width;
  const H = world.height;
  const layer = (id: string, label: string, body: string, attrs = "") => `<g id="${id}" ${INK} inkscape:label="${label}" ${attrs}>${body}</g>`;

  // Realm label anchors: circular mean of land cells across the seam
  const n = world.nations.length;
  const sumS = new Float64Array(n);
  const sumC = new Float64Array(n);
  const sumY = new Float64Array(n);
  const land = new Float64Array(n);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const c = world.grid[x][y];
      const k = c.nationIndex ?? -1;
      if (c.isWater || k < 0 || k >= n) continue;
      const a = (x / W) * Math.PI * 2;
      sumS[k] += Math.sin(a);
      sumC[k] += Math.cos(a);
      sumY[k] += y;
      land[k]++;
    }
  const maxLand = Math.max(1, ...land);

  const borders = traceBorders(world)
    .map((l) => polyline(smooth(l), W, ""))
    .join("");
  const rivers = world.rivers
    .map((r) => {
      const w = Math.max(0.12, Math.min(0.9, (Math.max(...r.widths, 1) / 1500) * 0.9));
      return polyline(r.points, W, `stroke-width="${r2(w)}"`);
    })
    .join("");
  const roadStyle = ['stroke-width="0.12" stroke-dasharray="0.4 0.3"', 'stroke-width="0.18"', 'stroke-width="0.28"'];
  const roads = world.worldRoads.map((r) => polyline(r.points, W, roadStyle[r.tier] ?? roadStyle[0])).join("");
  const sea = world.seaRoutes.map((r) => polyline(r.points, W, "")).join("");
  const dotR = [0.35, 0.6, 0.95];
  const settlements = world.cities
    .map((c) => `<circle cx="${r2(c.x)}" cy="${r2(c.y)}" r="${c.isCapital ? 1.15 : dotR[c.size] ?? 0.35}"${c.isCapital ? ' class="capital"' : ""}><title>${esc(c.name)}</title></circle>`)
    .join("");
  const townLabels = world.cities
    .filter((c) => c.size >= 1 || c.isCapital)
    .map((c) => `<text x="${r2(c.x + 1.3)}" y="${r2(c.y + 0.6)}" font-size="${c.size >= 2 || c.isCapital ? 2.2 : 1.6}">${esc(c.name)}</text>`)
    .join("");
  const realmLabels = world.nations
    .map((nt, i) => {
      if (!land[i]) return "";
      let x = (Math.atan2(sumS[i], sumC[i]) / (Math.PI * 2)) * W;
      if (x < 0) x += W;
      const y = sumY[i] / land[i];
      const size = r2(2.5 + 6 * Math.sqrt(land[i] / maxLand));
      return `<text x="${r2(x)}" y="${r2(y)}" font-size="${size}" letter-spacing="${r2(size * 0.18)}">${esc(nt.name.toUpperCase())}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
  width="${W * 4}" height="${H * 4}" viewBox="0 0 ${W} ${H}">
<title>${esc(title)}</title>
<desc>Generated world, ${W} x ${H} cells of 5 km. One SVG unit is one cell.</desc>
<defs><clipPath id="world"><rect width="${W}" height="${H}"/></clipPath></defs>
<g clip-path="url(#world)">
${layer("terrain", "Terrain", `<image width="${W}" height="${H}" preserveAspectRatio="none" xlink:href="${images.terrain}" href="${images.terrain}"/>`)}
${layer("realms", "Realm colors", `<image width="${W}" height="${H}" preserveAspectRatio="none" xlink:href="${images.realms}" href="${images.realms}"/>`, 'opacity="0.38"')}
${layer("rivers", "Rivers", rivers, 'fill="none" stroke="#3b7a99" stroke-linecap="round" stroke-linejoin="round"')}
${layer("sea-routes", "Sea routes", sea, 'fill="none" stroke="#e8f0f4" stroke-opacity="0.55" stroke-width="0.15" stroke-dasharray="0.8 0.6"')}
${layer("roads", "Roads", roads, 'fill="none" stroke="#6b4a2b" stroke-opacity="0.8" stroke-linecap="round" stroke-linejoin="round"')}
${layer("borders", "Borders", borders, 'fill="none" stroke="#fff" stroke-opacity="0.9" stroke-width="0.3" stroke-linejoin="round"')}
${layer("settlements", "Settlements", settlements, 'fill="#1f160b" stroke="#fff" stroke-width="0.15"')}
${layer("town-labels", "Town names", townLabels, 'font-family="Inter, Helvetica, Arial, sans-serif" fill="#1f160b" stroke="#fff" stroke-width="0.35" paint-order="stroke" stroke-linejoin="round"')}
${layer("realm-labels", "Realm names", realmLabels, 'font-family="Cormorant Garamond, Georgia, serif" font-weight="700" text-anchor="middle" dominant-baseline="middle" fill="#2a1d10" fill-opacity="0.8" stroke="#fff" stroke-opacity="0.6" stroke-width="0.4" paint-order="stroke"')}
</g>
</svg>
`;
}
