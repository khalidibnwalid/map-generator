import type { Nation } from "../WorldData";
import type { FlagSpec } from "../flags";
import { rulerStyle } from "./Rulers";

// Year-by-year record of political borders for the timeline and GIF export.
// Nations get a stable uid (indices shift when one falls), each year stores
// only the cells whose owner changed, and every KEY_EVERY frames a full
// run-length keyframe bounds the cost of seeking.

export interface SnapNation {
  uid: number;
  name: string;
  color: string;
  overlord: number; // uid, -1 if independent
  capitalX: number;
  capitalY: number;
  cultureId?: number;
  flag?: FlagSpec;
  ruler: string;
}

interface Frame {
  year: number;
  nations: SnapNation[];
  key: Int32Array | null; // [uid, run] pairs over all cells
  diffIdx: Int32Array | null; // changed cells since the previous frame
  diffVal: Int16Array | null;
  bytes: number;
}

// A recorded year as the renderer needs it: owner is an index into nations
export interface HistoryView {
  year: number;
  index: number;
  owner: Int16Array;
  nations: SnapNation[];
}

const KEY_EVERY = 40;
const MAX_FRAMES = 600;
const MAX_BYTES = 48 * 1024 * 1024;

export class HistoryRecorder {
  public frames: Frame[] = [];
  private uids = new WeakMap<Nation, number>();
  private nextUid = 0;
  private prev: Int16Array; // uid per cell at the last recorded frame
  private lastMeta = new Map<number, SnapNation>(); // reused while unchanged
  private bytes = 0;
  // Seek cache: the uid grid of frame `cursor`
  private cur: Int16Array;
  private cursor = -1;
  private out: Int16Array;
  private diffI: Int32Array = new Int32Array(1024);
  private diffV: Int16Array = new Int16Array(1024);

  constructor(cells: number) {
    this.prev = new Int16Array(cells).fill(-1);
    this.cur = new Int16Array(cells);
    this.out = new Int16Array(cells);
  }

  get length() {
    return this.frames.length;
  }

  private uidOf(n: Nation) {
    let u = this.uids.get(n);
    if (u === undefined) {
      u = this.nextUid++;
      this.uids.set(n, u);
    }
    return u;
  }

  public record(year: number, owner: Int16Array, nations: Nation[]) {
    const lut = new Int16Array(nations.length);
    nations.forEach((n, i) => (lut[i] = this.uidOf(n)));
    const metas = nations.map((n, i): SnapNation => {
      const uid = lut[i];
      const overlord = n.overlord !== undefined && n.overlord < nations.length ? lut[n.overlord] : -1;
      const ruler = rulerStyle(n);
      const m = this.lastMeta.get(uid);
      if (
        m &&
        m.name === n.name &&
        m.color === n.color &&
        m.overlord === overlord &&
        m.capitalX === n.capitalX &&
        m.capitalY === n.capitalY &&
        m.ruler === ruler &&
        m.flag === n.flag
      )
        return m;
      const fresh: SnapNation = {
        uid,
        name: n.name,
        color: n.color,
        overlord,
        capitalX: n.capitalX,
        capitalY: n.capitalY,
        cultureId: n.cultureId,
        flag: n.flag,
        ruler,
      };
      this.lastMeta.set(uid, fresh);
      return fresh;
    });

    // Diff against the previous frame, updating it in place
    const prev = this.prev;
    const count = nations.length;
    let k = 0;
    for (let i = 0; i < prev.length; i++) {
      const o = owner[i];
      const u = o >= 0 && o < count ? lut[o] : -1;
      if (u === prev[i]) continue;
      prev[i] = u;
      if (k === this.diffI.length) {
        const gi = new Int32Array(k * 2);
        gi.set(this.diffI);
        this.diffI = gi;
        const gv = new Int16Array(k * 2);
        gv.set(this.diffV);
        this.diffV = gv;
      }
      this.diffI[k] = i;
      this.diffV[k] = u;
      k++;
    }
    const keyframe = this.frames.length === 0 || this.frames.length % KEY_EVERY === 0;
    const frame: Frame = {
      year,
      nations: metas,
      key: keyframe ? rle(prev) : null,
      diffIdx: keyframe ? null : this.diffI.slice(0, k),
      diffVal: keyframe ? null : this.diffV.slice(0, k),
      bytes: 0,
    };
    frame.bytes = (frame.key?.byteLength ?? 0) + (frame.diffIdx?.byteLength ?? 0) + (frame.diffVal?.byteLength ?? 0) + metas.length * 8;
    this.frames.push(frame);
    this.bytes += frame.bytes;
    while (this.frames.length > 2 && (this.frames.length > MAX_FRAMES || this.bytes > MAX_BYTES)) this.dropOldest();
  }

  // The oldest year goes; the next one becomes a keyframe
  private dropOldest() {
    const next = this.frames[1];
    if (!next.key) {
      this.seekUids(1);
      next.key = rle(this.cur);
      this.bytes -= (next.diffIdx?.byteLength ?? 0) + (next.diffVal?.byteLength ?? 0);
      next.diffIdx = next.diffVal = null;
      this.bytes += next.key.byteLength;
    }
    this.bytes -= this.frames[0].bytes;
    this.frames.shift();
    this.cursor = -1;
  }

  // Fills `cur` with the uid grid of frame f
  private seekUids(f: number) {
    const frames = this.frames;
    let start = f;
    while (start > 0 && !frames[start].key) start--;
    // Continue from the cached frame when it lies between the keyframe and f
    if (!(this.cursor >= start && this.cursor <= f)) {
      unrle(frames[start].key!, this.cur);
      this.cursor = start;
    }
    for (let k = this.cursor + 1; k <= f; k++) {
      const fr = frames[k];
      if (fr.key) {
        unrle(fr.key, this.cur);
        continue;
      }
      const di = fr.diffIdx!;
      const dv = fr.diffVal!;
      for (let j = 0; j < di.length; j++) this.cur[di[j]] = dv[j];
    }
    this.cursor = f;
  }

  // Frame f with owners as indices into its nation list. The returned
  // owner array is reused by the next call.
  public view(f: number): HistoryView | null {
    const frame = this.frames[f];
    if (!frame) return null;
    this.seekUids(f);
    let maxUid = 0;
    for (const n of frame.nations) if (n.uid > maxUid) maxUid = n.uid;
    const lut = new Int16Array(maxUid + 1).fill(-1);
    frame.nations.forEach((n, i) => (lut[n.uid] = i));
    const cur = this.cur;
    const out = this.out;
    for (let i = 0; i < cur.length; i++) {
      const u = cur[i];
      out[i] = u >= 0 && u <= maxUid ? lut[u] : -1;
    }
    return { year: frame.year, index: f, owner: out, nations: frame.nations };
  }

  public indexOfYear(year: number): number {
    if (!this.frames.length) return -1;
    const i = year - this.frames[0].year; // years are consecutive
    return Math.max(0, Math.min(this.frames.length - 1, i));
  }
}

function rle(values: Int16Array): Int32Array {
  const pairs: number[] = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i];
    let j = i + 1;
    while (j < values.length && values[j] === v) j++;
    pairs.push(v, j - i);
    i = j;
  }
  return Int32Array.from(pairs);
}

function unrle(pairs: Int32Array, out: Int16Array) {
  let o = 0;
  for (let k = 0; k < pairs.length; k += 2) {
    out.fill(pairs[k], o, o + pairs[k + 1]);
    o += pairs[k + 1];
  }
}

// Label anchors for a recorded year: land area and wrap-aware centroid per nation
export function viewStats(view: HistoryView, W: number, H: number, waterType: Uint8Array) {
  const n = view.nations.length;
  const TAU = Math.PI * 2;
  const sumSin = new Float64Array(n);
  const sumCos = new Float64Array(n);
  const sumY = new Float64Array(n);
  const land = new Float64Array(n);
  const sinX = new Float64Array(W);
  const cosX = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    sinX[x] = Math.sin((x / W) * TAU);
    cosX[x] = Math.cos((x / W) * TAU);
  }
  const owner = view.owner;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const k = owner[i];
      if (k < 0 || waterType[i] !== 0) continue;
      land[k]++;
      sumSin[k] += sinX[x];
      sumCos[k] += cosX[x];
      sumY[k] += y;
    }
  let maxLand = 1;
  for (let k = 0; k < n; k++) if (land[k] > maxLand) maxLand = land[k];
  const centroids = view.nations.map((nt, k) => {
    if (!land[k]) return { x: nt.capitalX, y: nt.capitalY };
    let x = (Math.atan2(sumSin[k], sumCos[k]) / TAU) * W;
    if (x < 0) x += W;
    return { x, y: sumY[k] / land[k] };
  });
  return {
    land: Array.from(land),
    sizes: Array.from(land, (v) => Math.sqrt(v / maxLand)),
    centroids,
  };
}
