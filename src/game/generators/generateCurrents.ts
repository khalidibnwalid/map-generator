import type { GeneratorContext } from "./types";
import { yieldFrame } from "../util/grid";

export interface CurrentField {
  step: number; // world cells per sample
  w: number;
  h: number;
  u: Float32Array; // eastward component, normalized to max speed 1
  v: Float32Array; // southward component (screen y)
  warm: Float32Array; // +1 warm (from the equator), -1 cold (from the poles)
}

// Wind-driven surface circulation. Zonal winds (trade winds, westerlies,
// polar easterlies) put curl into the ocean; solving the Poisson equation for
// a stream function with psi = 0 on land closes the flow along coasts into
// basin-scale gyres, like the real subtropical and subpolar gyres.
export async function generateCurrents(ctx: GeneratorContext): Promise<void> {
  const { world, width: W, height: H, onProgress } = ctx;
  const step = Math.max(2, Math.round(W / 200));
  const w = Math.floor(W / step);
  const h = Math.floor(H / step);
  const N = w * h;
  const sea = new Uint8Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * step + (step >> 1)) * W + x * step + (step >> 1);
      sea[y * w + x] = world.waterType[i] === 1 ? 1 : 0;
    }

  // Zonal wind by latitude (deg): easterly trades, westerlies, polar easterlies
  const wind = (lat: number) => {
    const a = Math.abs(lat);
    if (a < 30) return -Math.cos((a / 30) * (Math.PI / 2)) * 0.9 - 0.1;
    if (a < 60) return Math.sin(((a - 30) / 30) * Math.PI);
    return -0.5 * Math.sin(((a - 60) / 30) * Math.PI);
  };
  // Forcing = -d(wind)/dy (curl of a purely zonal wind)
  const force = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const lat0 = 90 - ((y - 0.5) / h) * 180;
    const lat1 = 90 - ((y + 0.5) / h) * 180;
    const f = -(wind(lat1) - wind(lat0));
    for (let x = 0; x < w; x++) force[y * w + x] = f;
  }

  // Jacobi / SOR relaxation of  laplacian(psi) = force  on sea cells
  const psi = new Float32Array(N);
  const iters = 500;
  const omega = 1.85;
  for (let it = 0; it < iters; it++) {
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = (y + pass) & 1; x < w; x += 2) {
          const i = y * w + x;
          if (!sea[i]) continue;
          const l = y * w + ((x - 1 + w) % w);
          const r = y * w + ((x + 1) % w);
          const s = (psi[l] + psi[r] + psi[i - w] + psi[i + w] - force[i]) * 0.25;
          psi[i] += omega * (s - psi[i]);
        }
      }
    }
    if (it % 100 === 99) {
      onProgress?.((it / iters) * 90);
      await yieldFrame();
    }
  }

  const u = new Float32Array(N);
  const v = new Float32Array(N);
  const warm = new Float32Array(N);
  let maxS = 1e-9;
  for (let y = 1; y < h - 1; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!sea[i]) continue;
      const l = y * w + ((x - 1 + w) % w);
      const r = y * w + ((x + 1) % w);
      // Screen y grows southward: u = -dpsi/dy, v = dpsi/dx
      u[i] = -(psi[i + w] - psi[i - w]) * 0.5;
      v[i] = (psi[r] - psi[l]) * 0.5;
      maxS = Math.max(maxS, Math.hypot(u[i], v[i]));
    }
  for (let i = 0; i < N; i++) {
    u[i] /= maxS;
    v[i] /= maxS;
    const y = Math.floor(i / w);
    // Flow heading toward the pole carries warm water, toward the equator cold
    const north = y < h / 2;
    const poleward = north ? -v[i] : v[i];
    warm[i] = Math.max(-1, Math.min(1, poleward * 4));
  }
  world.currents = { step, w, h, u, v, warm };
  onProgress?.(100);
}

// Bilinear current sample at a world position (cells); returns [u, v, warm]
export function sampleCurrent(f: CurrentField, _worldW: number, x: number, y: number): [number, number, number] {
  const fx = x / f.step - 0.5;
  const fy = y / f.step - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.max(0, Math.min(f.h - 2, Math.floor(fy)));
  const tx = fx - x0;
  const ty = Math.max(0, Math.min(1, fy - y0));
  const out: [number, number, number] = [0, 0, 0];
  const arrs = [f.u, f.v, f.warm];
  for (let k = 0; k < 3; k++) {
    const a = arrs[k];
    const at = (xx: number, yy: number) => a[yy * f.w + (((xx % f.w) + f.w) % f.w)];
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bot = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    out[k] = top * (1 - ty) + bot * ty;
  }
  return out;
}
