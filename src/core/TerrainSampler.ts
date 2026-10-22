import { coastNoise, coastTaper, decodeSdf, COAST_NOISE_BAND, COAST_OCTAVES } from "./FieldNoise";
import type { WorldData } from "../game/WorldData";

// CPU mirror of the shader's terrain lookups, so generated geometry (cities,
// river mouths, piers) lines up with what is drawn on screen.
export class TerrainSampler {
  private W: number;
  private H: number;
  private sdf: Float32Array;
  private elev: Float32Array;
  private seed: number;

  constructor(world: WorldData) {
    this.W = world.width;
    this.H = world.height;
    this.seed = world.seed >>> 0;
    const N = this.W * this.H;
    this.sdf = new Float32Array(N);
    for (let i = 0; i < N; i++) this.sdf[i] = decodeSdf(world.coastSdf[i]);
    this.elev = new Float32Array(N);
    for (let x = 0; x < this.W; x++) {
      for (let y = 0; y < this.H; y++) {
        // Same 8-bit quantization as the GPU texture
        this.elev[y * this.W + x] =
          Math.floor(world.grid[x][y].elevation * 255) / 255;
      }
    }
  }

  private texel(arr: Float32Array, tx: number, ty: number): number {
    tx = ((tx % this.W) + this.W) % this.W;
    ty = ty < 0 ? 0 : ty >= this.H ? this.H - 1 : ty;
    return arr[ty * this.W + tx];
  }

  private bilinear(arr: Float32Array, cx: number, cy: number, lx: number, ly: number) {
    const tx = lx - 0.5;
    const ty = ly - 0.5;
    const fx0 = Math.floor(tx);
    const fy0 = Math.floor(ty);
    const wx = tx - fx0;
    const wy = ty - fy0;
    const x0 = cx + fx0;
    const y0 = cy + fy0;
    const a = this.texel(arr, x0, y0);
    const b = this.texel(arr, x0 + 1, y0);
    const c = this.texel(arr, x0, y0 + 1);
    const d = this.texel(arr, x0 + 1, y0 + 1);
    const top = a + (b - a) * wx;
    const bot = c + (d - c) * wx;
    return top + (bot - top) * wy;
  }

  // Signed distance-ish field in cells: > 0 land, < 0 water. Matches the shader.
  public coastField(x: number, y: number, octaves: number = COAST_OCTAVES): number {
    const cxRaw = Math.floor(x);
    const cy = Math.floor(y);
    const lx = x - cxRaw;
    const ly = y - cy;
    const cx = ((cxRaw % this.W) + this.W) % this.W;
    const s = this.bilinear(this.sdf, cx, cy, lx, ly);
    if (Math.abs(s) > COAST_NOISE_BAND) return s;
    return s + coastNoise(cx, cy, lx, ly, this.W, this.seed, octaves) * coastTaper(s);
  }

  public isWater(x: number, y: number): boolean {
    return this.coastField(x, y) < 0;
  }

  public elevation(x: number, y: number): number {
    const cxRaw = Math.floor(x);
    const cy = Math.floor(y);
    const cx = ((cxRaw % this.W) + this.W) % this.W;
    return this.bilinear(this.elev, cx, cy, x - cxRaw, y - cy);
  }
}
