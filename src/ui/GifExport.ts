import { BIOME_COLORS, type WorldData } from "../game/WorldData";
import { viewStats, type HistoryRecorder, type HistoryView } from "../game/sim/History";
import type { Battle } from "../game/sim/Simulation";
import { drawSwords } from "./WarRenderer";

// Animated GIF of the recorded history, encoded in the browser: frames are
// composed on a 2D canvas (biome colors with hill shading, nation tints,
// borders, labels, year caption), quantized to one median-cut palette and
// LZW-compressed. Each frame only stores the rectangle that changed.

const OUT_W = 800;
const MAX_FRAMES = 240;
const TRANSPARENT = 255;

export async function exportHistoryGif(
  world: WorldData,
  history: HistoryRecorder,
  battles: Battle[],
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const W = world.width;
  const H = world.height;
  const w = OUT_W;
  const h = Math.round((OUT_W * H) / W);
  const P = w * h;

  // Output pixel -> world cell
  const cellOf = new Int32Array(P);
  for (let py = 0; py < h; py++) {
    const cy = Math.min(H - 1, Math.floor(((py + 0.5) * H) / h));
    for (let px = 0; px < w; px++) cellOf[py * w + px] = cy * W + Math.min(W - 1, Math.floor(((px + 0.5) * W) / w));
  }
  const base = terrainBase(world, cellOf, w, h);
  const land = new Uint8Array(P);
  for (let p = 0; p < P; p++) land[p] = world.waterType[cellOf[p]] === 0 ? 1 : 0;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.createImageData(w, h);
  const owner = new Int16Array(P);

  const frame = (view: HistoryView) => {
    const d = img.data;
    const n = view.nations.length;
    const lut = new Uint8Array(n * 3);
    view.nations.forEach((nt, i) => {
      const v = parseInt(nt.color.slice(1, 7), 16);
      lut[i * 3] = (v >> 16) & 255;
      lut[i * 3 + 1] = (v >> 8) & 255;
      lut[i * 3 + 2] = v & 255;
    });
    for (let p = 0; p < P; p++) owner[p] = view.owner[cellOf[p]];
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const p = py * w + px;
        const o = owner[p];
        let r = base[p * 3];
        let g = base[p * 3 + 1];
        let b = base[p * 3 + 2];
        if (o >= 0) {
          const a = land[p] ? 0.45 : 0.18;
          r += (lut[o * 3] - r) * a;
          g += (lut[o * 3 + 1] - g) * a;
          b += (lut[o * 3 + 2] - b) * a;
          // Border where a land neighbor belongs to someone else
          if (land[p]) {
            const right = px + 1 < w ? p + 1 : p - px;
            const down = py + 1 < h ? p + w : -1;
            if ((land[right] && owner[right] !== o) || (down >= 0 && land[down] && owner[down] !== o)) {
              r *= 0.35;
              g *= 0.3;
              b *= 0.28;
            }
          }
        }
        d[p * 4] = r;
        d[p * 4 + 1] = g;
        d[p * 4 + 2] = b;
        d[p * 4 + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    drawLabels(ctx, view, world, w / W);
    for (const bt of battles) {
      const age = view.year - bt.year;
      if (age < 0 || age > 4) continue;
      drawSwords(ctx, bt.x * (w / W), bt.y * (h / H), Math.min(8, 3 + Math.sqrt(bt.size) * 0.4), 1 - age / 5);
    }
    // Year caption
    ctx.font = "600 20px Georgia, 'Times New Roman', serif";
    const text = `Year ${view.year}`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(20, 16, 11, 0.78)";
    ctx.fillRect(12, h - 44, tw + 24, 32);
    ctx.strokeStyle = "#d4a85a";
    ctx.lineWidth = 1;
    ctx.strokeRect(12.5, h - 43.5, tw + 23, 31);
    ctx.fillStyle = "#f3e6c8";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 24, h - 28);
    return ctx.getImageData(0, 0, w, h).data;
  };

  // Which recorded years become frames
  const total = history.length;
  const step = Math.max(1, Math.ceil(total / MAX_FRAMES));
  const picks: number[] = [];
  for (let f = 0; f < total; f += step) picks.push(f);
  if (picks[picks.length - 1] !== total - 1) picks.push(total - 1);

  // One global palette from a handful of sample frames
  const hist = new Uint32Array(32768);
  const samples = [0, 0.25, 0.5, 0.75, 1].map((t) => picks[Math.round(t * (picks.length - 1))]);
  for (const f of new Set(samples)) {
    const px = frame(history.view(f)!);
    for (let p = 0; p < P; p++) hist[((px[p * 4] >> 3) << 10) | ((px[p * 4 + 1] >> 3) << 5) | (px[p * 4 + 2] >> 3)]++;
    await idle();
  }
  // 255 real colors; index 255 is transparent ("unchanged since the last frame")
  const palette = new Uint8Array(768);
  palette.set(medianCut(hist, 255));
  const nearest = new Int16Array(32768).fill(-1);
  const mapColor = (key: number) => {
    let best = 0;
    let bd = Infinity;
    const r = ((key >> 10) << 3) + 4;
    const g = (((key >> 5) & 31) << 3) + 4;
    const b = ((key & 31) << 3) + 4;
    for (let k = 0; k < 255 * 3; k += 3) {
      const dr = palette[k] - r;
      const dg = palette[k + 1] - g;
      const db = palette[k + 2] - b;
      const dd = dr * dr * 2 + dg * dg * 3 + db * db;
      if (dd < bd) {
        bd = dd;
        best = k / 3;
      }
    }
    nearest[key] = best;
    return best;
  };

  const gif = new GifWriter(w, h, palette);
  let prev: Uint8Array | null = null;
  for (let k = 0; k < picks.length; k++) {
    const px = frame(history.view(picks[k])!);
    const idx = new Uint8Array(P);
    for (let p = 0; p < P; p++) {
      const key = ((px[p * 4] >> 3) << 10) | ((px[p * 4 + 1] >> 3) << 5) | (px[p * 4 + 2] >> 3);
      const v = nearest[key];
      idx[p] = v >= 0 ? v : mapColor(key);
    }
    const delay = k === picks.length - 1 ? 300 : k === 0 ? 80 : step > 1 ? 12 : 9;
    gif.frame(idx, prev, delay);
    prev = idx;
    onProgress((k + 1) / picks.length);
    await idle();
  }
  return gif.finish();
}

const idle = () => new Promise<void>((r) => setTimeout(r, 0));

// Biome colors with a little hill shading, per output pixel (RGB)
function terrainBase(world: WorldData, cellOf: Int32Array, w: number, h: number): Uint8Array {
  const W = world.width;
  const H = world.height;
  const out = new Uint8Array(w * h * 3);
  const cache = new Map<string, number>();
  const elev = (x: number, y: number) => world.grid[((x % W) + W) % W][Math.max(0, Math.min(H - 1, y))].elevation;
  for (let p = 0; p < w * h; p++) {
    const c = cellOf[p];
    const x = c % W;
    const y = Math.floor(c / W);
    const cell = world.grid[x][y];
    if (world.waterType[c] === 1) {
      // Open sea: a smooth depth ramp instead of banded biome colors
      const t = Math.max(0, Math.min(1, cell.elevation / 0.45)) ** 1.5;
      out[p * 3] = 18 + t * 48;
      out[p * 3 + 1] = 42 + t * 76;
      out[p * 3 + 2] = 68 + t * 82;
      continue;
    }
    const hex = BIOME_COLORS[cell.biome] ?? "#74A152";
    let v = cache.get(hex);
    if (v === undefined) {
      v = parseInt(hex.slice(1), 16);
      cache.set(hex, v);
    }
    let shade = 1;
    if (!cell.isWater) shade = Math.max(0.7, Math.min(1.25, 1 + (elev(x - 1, y - 1) - elev(x + 1, y + 1)) * 6));
    out[p * 3] = Math.min(255, ((v >> 16) & 255) * shade);
    out[p * 3 + 1] = Math.min(255, ((v >> 8) & 255) * shade);
    out[p * 3 + 2] = Math.min(255, (v & 255) * shade);
  }
  return out;
}

function drawLabels(ctx: CanvasRenderingContext2D, view: HistoryView, world: WorldData, k: number) {
  const st = viewStats(view, world.width, world.height, world.waterType);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const order = view.nations.map((_, i) => i).sort((a, b) => st.land[b] - st.land[a]);
  for (const i of order) {
    const extent = Math.sqrt(st.land[i]) * k;
    if (extent < 46) break;
    const size = Math.max(9, Math.min(18, Math.floor(extent * 0.12)));
    ctx.font = `bold ${size}px Georgia, 'Times New Roman', serif`;
    const name = view.nations[i].name.toUpperCase();
    if (ctx.measureText(name).width > extent * 1.3) continue;
    const c = st.centroids[i];
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(245, 236, 214, 0.75)";
    ctx.strokeText(name, c.x * k, c.y * k);
    ctx.fillStyle = "#2a1d12";
    ctx.fillText(name, c.x * k, c.y * k);
  }
}

// Median cut over a 15-bit color histogram; returns flat RGB triples
function medianCut(hist: Uint32Array, colors: number): Uint8Array {
  const keys: number[] = [];
  for (let k = 0; k < hist.length; k++) if (hist[k]) keys.push(k);
  const ch = (key: number, c: number) => (c === 0 ? key >> 10 : c === 1 ? (key >> 5) & 31 : key & 31);
  type Box = { keys: number[]; range: number; channel: number; weight: number };
  const makeBox = (ks: number[]): Box => {
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    let weight = 0;
    for (const key of ks) {
      weight += hist[key];
      for (let c = 0; c < 3; c++) {
        const v = ch(key, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    const spans = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const channel = spans.indexOf(Math.max(...spans));
    return { keys: ks, range: spans[channel], channel, weight };
  };
  const boxes = [makeBox(keys)];
  while (boxes.length < colors) {
    // Split the box with the most pixels spread over the widest range
    let bi = -1;
    let score = 0;
    boxes.forEach((b, i) => {
      const s = b.range * Math.sqrt(b.weight);
      if (b.keys.length > 1 && b.range > 0 && s > score) {
        score = s;
        bi = i;
      }
    });
    if (bi < 0) break;
    const b = boxes[bi];
    b.keys.sort((p, q) => ch(p, b.channel) - ch(q, b.channel));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < b.keys.length - 1; i++) {
      acc += hist[b.keys[i]];
      if (acc >= b.weight / 2) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(bi, 1, makeBox(b.keys.slice(0, cut)), makeBox(b.keys.slice(cut)));
  }
  const out = new Uint8Array(colors * 3);
  boxes.forEach((b, i) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const key of b.keys) {
      const n = hist[key];
      r += (((key >> 10) << 3) + 4) * n;
      g += ((((key >> 5) & 31) << 3) + 4) * n;
      bl += (((key & 31) << 3) + 4) * n;
    }
    const wgt = Math.max(1, b.weight);
    out[i * 3] = Math.round(r / wgt);
    out[i * 3 + 1] = Math.round(g / wgt);
    out[i * 3 + 2] = Math.round(bl / wgt);
  });
  return out;
}

class ByteBuf {
  private buf = new Uint8Array(1 << 16);
  public length = 0;
  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.length));
    this.buf = b;
  }
  byte(v: number) {
    this.grow(1);
    this.buf[this.length++] = v;
  }
  word(v: number) {
    this.byte(v & 255);
    this.byte((v >> 8) & 255);
  }
  bytes(arr: ArrayLike<number>, n = arr.length) {
    this.grow(n);
    for (let i = 0; i < n; i++) this.buf[this.length++] = arr[i];
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  data() {
    return this.buf.slice(0, this.length);
  }
}

// Minimal GIF89a writer: global 256-color palette, looping, one image per frame
class GifWriter {
  private out = new ByteBuf();
  private w: number;
  private h: number;

  constructor(w: number, h: number, palette: Uint8Array) {
    this.w = w;
    this.h = h;
    const o = this.out;
    o.ascii("GIF89a");
    o.word(w);
    o.word(h);
    o.byte(0xf7); // global color table, 8 bits, 256 entries
    o.byte(0);
    o.byte(0);
    o.bytes(palette, 768);
    // NETSCAPE2.0: loop forever
    o.byte(0x21);
    o.byte(0xff);
    o.byte(11);
    o.ascii("NETSCAPE2.0");
    o.byte(3);
    o.byte(1);
    o.word(0);
    o.byte(0);
  }

  // Encodes only the bounding box of pixels that differ from the previous
  // frame; inside it, unchanged pixels are transparent so they compress to
  // long runs. Index 255 must be unused by the image.
  frame(idx: Uint8Array, prev: Uint8Array | null, delayCs: number) {
    const w = this.w;
    let x0 = 0;
    let y0 = 0;
    let x1 = w - 1;
    let y1 = this.h - 1;
    if (prev) {
      x0 = w;
      y0 = this.h;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < this.h; y++)
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (idx[p] === prev[p]) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      if (x1 < 0) x0 = y0 = x1 = y1 = 0; // identical: a 1-pixel frame keeps the timing
    }
    const fw = x1 - x0 + 1;
    const fh = y1 - y0 + 1;
    const sub = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) {
      const row = (y0 + y) * w + x0;
      for (let x = 0; x < fw; x++) sub[y * fw + x] = prev && prev[row + x] === idx[row + x] ? TRANSPARENT : idx[row + x];
    }
    const o = this.out;
    o.byte(0x21);
    o.byte(0xf9);
    o.byte(4);
    o.byte((1 << 2) | (prev ? 1 : 0)); // disposal: leave in place; transparency after the first frame
    o.word(delayCs);
    o.byte(TRANSPARENT);
    o.byte(0);
    o.byte(0x2c);
    o.word(x0);
    o.word(y0);
    o.word(fw);
    o.word(fh);
    o.byte(0);
    lzw(sub, 8, o);
  }

  finish(): Blob {
    this.out.byte(0x3b);
    return new Blob([this.out.data()], { type: "image/gif" });
  }
}

// GIF LZW with variable code size (up to 12 bits), packed into 255-byte sub-blocks
function lzw(indices: Uint8Array, minCode: number, o: ByteBuf) {
  o.byte(minCode);
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let next = eoi + 1;
  let size = minCode + 1;
  const HSIZE = 8191;
  const hkey = new Int32Array(HSIZE).fill(-1);
  const hval = new Int16Array(HSIZE);
  const block = new Uint8Array(255);
  let bl = 0;
  let cur = 0;
  let bits = 0;
  const emit = (code: number) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      block[bl++] = cur & 255;
      cur >>>= 8;
      bits -= 8;
      if (bl === 255) {
        o.byte(255);
        o.bytes(block, 255);
        bl = 0;
      }
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    let hh = (key * 31 + k) % HSIZE;
    while (hkey[hh] !== -1 && hkey[hh] !== key) hh = hh + 1 === HSIZE ? 0 : hh + 1;
    if (hkey[hh] === key) {
      prefix = hval[hh];
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      hkey.fill(-1);
      next = eoi + 1;
      size = minCode + 1;
    } else {
      if (next >= 1 << size) size++;
      hkey[hh] = key;
      hval[hh] = next++;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) {
    block[bl++] = cur & 255;
    if (bl === 255) {
      o.byte(255);
      o.bytes(block, 255);
      bl = 0;
    }
  }
  if (bl) {
    o.byte(bl);
    o.bytes(block, bl);
  }
  o.byte(0);
}
