export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// How swollen rivers and lakes are (0..1) in `month` (0 = mid-January, may be
// fractional) at signed latitude latS (-1 north pole .. 1 south pole): spring
// melt away from the equator, the wet season in the tropics. Mirrors
// seasonState()/seasonFlood() in MapShader.ts.
export function seasonFlood(month: number, latS: number): number {
  const a = (Math.PI * 2) / 12;
  const hs = smooth(-0.03, 0.03, latS);
  const winter = Math.cos(a * (month - 0.4)) * (1 - 2 * hs);
  const thawN = Math.pow(Math.max(0, Math.cos(a * (month - 3.5))), 3);
  const thawS = Math.pow(Math.max(0, Math.cos(a * (month - 9.5))), 3);
  const thaw = thawN + (thawS - thawN) * hs;
  const lat = Math.abs(latS);
  const amp = smooth(0.12, 0.5, lat);
  const tropic = smooth(0.03, 0.12, lat) * (1 - smooth(0.35, 0.55, lat));
  return Math.max(thaw * amp, Math.max(0, -winter) * tropic * 0.6);
}
