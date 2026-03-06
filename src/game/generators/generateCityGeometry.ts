import type { GeneratorContext } from "./types";
import { DistrictType } from "../WorldData";
import type { Polygon, Point, CityBlock, Building } from "../WorldData";

// Exact replication of GLSL fractional brownian motion used in the GPURenderer for subpixel shorelines
function fbm_high(x: number, y: number): number {
  let value = 0.0;
  let amplitude = 0.5;
  let px = x;
  let py = y;

  // Using simple value noise matching the shader's `rand` and `noise`
  // This is distinct from Simplex (noise2D). Let's implement the specific GLSL rand here
  // float rand(vec2 co) { return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453); }
  const rand = (vx: number, vy: number) => {
    let dot = vx * 12.9898 + vy * 78.233;
    let sin = Math.sin(dot) * 43758.5453;
    return sin - Math.floor(sin);
  };

  const noiseVal = (nx: number, ny: number) => {
    let ix = Math.floor(nx);
    let iy = Math.floor(ny);
    let fx = nx - ix;
    let fy = ny - iy;

    let a = rand(ix, iy);
    let b = rand(ix + 1.0, iy);
    let c = rand(ix, iy + 1.0);
    let d = rand(ix + 1.0, iy + 1.0);

    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uy = fy * fy * (3.0 - 2.0 * fy);

    return (
      a * (1 - ux) * (1 - uy) +
      b * ux * (1 - uy) +
      c * (1 - ux) * uy +
      d * ux * uy
    );
  };

  for (let i = 0; i < 6; i++) {
    value += amplitude * noiseVal(px, py);
    px *= 2.0;
    py *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}
function getInterpolatedElevation(
  x: number,
  y: number,
  ctx: GeneratorContext,
): number {
  const { world, width, height } = ctx;

  // Coordinate in WebGL texture space: (x/width, y/height)
  // WebGL LINEAR interpolation samples between texel centers.
  // Texel (i, j) center is at x = i + 0.5, y = j + 0.5
  const tx = x - 0.5;
  const ty = y - 0.5;

  const ix = Math.floor(tx);
  const iy = Math.floor(ty);
  const fx = tx - ix;
  const fy = ty - iy;

  // WebGL texture wraps on X, but clamps on Y.
  // Replicate the 8-bit precision of the GPU texture upload
  const getElev = (gx: number, gy: number) => {
    const cx = ((gx % width) + width) % width;
    const cy = Math.max(0, Math.min(height - 1, gy));
    const rawElev = world.grid[cx][cy].elevation;
    return Math.floor(Math.max(0, rawElev) * 255) / 255;
  };

  const e00 = getElev(ix, iy);
  const e10 = getElev(ix + 1, iy);
  const e01 = getElev(ix, iy + 1);
  const e11 = getElev(ix + 1, iy + 1);

  return (
    e00 * (1 - fx) * (1 - fy) +
    e10 * fx * (1 - fy) +
    e01 * (1 - fx) * fy +
    e11 * fx * fy
  );
}

function isVisuallyWater(x: number, y: number, ctx: GeneratorContext): boolean {
  // Shader's exact coordinate calculations
  // wxwy is continuous coordinate (x, y)
  // The shader evaluates fbm_high(wxwy * 0.5)
  // At high zooms, clamp(u_scale * 0.1, 0, 1) is 1.0, so shoreNoise is exactly:
  const shoreNoise = (fbm_high(x * 0.5, y * 0.5) - 0.5) * 0.05;

  // To perfectly match GPURenderer, we must bilinearly interpolate the 8-bit elevation map
  const elevation = getInterpolatedElevation(x, y, ctx);
  const renderedElevation = elevation + shoreNoise;

  return renderedElevation < 0.45;
}

function isPolygonInWater(polygon: Polygon, ctx: GeneratorContext): boolean {
  const centroid = getCentroid(polygon);
  if (isVisuallyWater(centroid.x, centroid.y, ctx)) return true;

  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    if (isVisuallyWater(p1.x, p1.y, ctx)) return true;

    // Check midpoint for extra safety against concave shorelines
    const p2 = polygon[(i + 1) % polygon.length];
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    if (isVisuallyWater(mx, my, ctx)) return true;
  }
  return false;
}

// 2D Geometry Utilities
function getCentroid(polygon: Polygon): Point {
  let cx = 0,
    cy = 0;
  for (const p of polygon) {
    cx += p.x;
    cy += p.y;
  }
  return { x: cx / polygon.length, y: cy / polygon.length };
}

function getArea(polygon: Polygon): number {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j].x + polygon[i].x) * (polygon[j].y - polygon[i].y);
  }
  return Math.abs(area / 2.0);
}

function shrinkPolygon(polygon: Polygon, amount: number): Polygon {
  const centroid = getCentroid(polygon);
  return polygon.map((p) => {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= amount) return { ...centroid };
    return {
      x: p.x - (dx / dist) * amount,
      y: p.y - (dy / dist) * amount,
    };
  });
}

function getDistance(p1: Point, p2: Point): number {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

// Split a polygon with a line defined by point and direction
function splitPolygon(
  polygon: Polygon,
  linePoint: Point,
  lineDir: Point,
): [Polygon, Polygon] | null {
  const poly1: Polygon = [];
  const poly2: Polygon = [];
  const nx = -lineDir.y;
  const ny = lineDir.x; // Normal to the line

  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];

    const p1Side =
      (current.x - linePoint.x) * nx + (current.y - linePoint.y) * ny >= 0;
    const p2Side =
      (next.x - linePoint.x) * nx + (next.y - linePoint.y) * ny >= 0;

    if (p1Side) poly1.push(current);
    else poly2.push(current);

    if (p1Side !== p2Side) {
      // Find intersection
      const x1 = current.x,
        y1 = current.y;
      const x2 = next.x,
        y2 = next.y;
      const x3 = linePoint.x,
        y3 = linePoint.y;
      const x4 = linePoint.x + lineDir.x,
        y4 = linePoint.y + lineDir.y;

      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(den) > 0.0001) {
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
        const intersect = {
          x: x1 + t * (x2 - x1),
          y: y1 + t * (y2 - y1),
        };
        poly1.push(intersect);
        poly2.push(intersect);
      }
    }
  }

  if (poly1.length >= 3 && poly2.length >= 3) return [poly1, poly2];
  return null; // Didn't actually split nicely
}

function buildOrganicCityShape(
  cx: number,
  cy: number,
  radius: number,
): { outline: Polygon; towers: Point[] } {
  const outline: Polygon = [];
  const towers: Point[] = [];
  const sides = 24 + Math.floor(Math.random() * 16);

  // Create an organic blob
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    // Layered noise for organic shape
    const r = radius * (0.7 + Math.random() * 0.5);
    outline.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }

  // Smooth it a bit
  const smoothed: Polygon = [];
  for (let i = 0; i < outline.length; i++) {
    const pPrev = outline[(i - 1 + outline.length) % outline.length];
    const p = outline[i];
    const pNext = outline[(i + 1) % outline.length];
    smoothed.push({
      x: (pPrev.x + p.x * 2 + pNext.x) / 4,
      y: (pPrev.y + p.y * 2 + pNext.y) / 4,
    });
  }

  // Generate towers along the smoothed outline
  let perimeterPos = 0;
  const towerSpacing = 0.4 + Math.random() * 0.2; // Distance between towers
  for (let i = 0; i < smoothed.length; i++) {
    const p1 = smoothed[i];
    const p2 = smoothed[(i + 1) % smoothed.length];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

    perimeterPos += dist;
    if (perimeterPos >= towerSpacing) {
      towers.push({ ...p2 });
      perimeterPos = 0; // reset
    }
  }

  return { outline: smoothed, towers };
}

function adaptToCoastline(polygon: Polygon, ctx: GeneratorContext): Polygon {
  const centroid = getCentroid(polygon);
  return polygon.map((p) => {
    let pt = { ...p };
    // Raycast inward from vertex towards centroid until it's not water
    let attempts = 0;
    while (isVisuallyWater(pt.x, pt.y, ctx) && attempts < 50) {
      pt.x = pt.x + (centroid.x - pt.x) * 0.05; // finer step
      pt.y = pt.y + (centroid.y - pt.y) * 0.05;
      attempts++;
    }
    return pt;
  });
}

export async function generateCityGeometry(
  ctx: GeneratorContext,
): Promise<void> {
  const { world, onProgress } = ctx;

  const totalCities = world.cities.length;
  for (let c = 0; c < totalCities; c++) {
    if (c % 5 === 0) {
      onProgress?.(95 + (c / totalCities) * 5); // From 95% to 100%
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const city = world.cities[c];
    const cityCenter = { x: city.x, y: city.y };

    // Base max radius for the city layout
    const maxRadius = city.isCapital ? 2.5 : city.size === 1 ? 1.5 : 0.8;
    const hasWall = city.size > 0; // Towns and capitals have walls

    let { outline, towers } = buildOrganicCityShape(city.x, city.y, maxRadius);
    outline = adaptToCoastline(outline, ctx);

    if (!hasWall) towers = []; // Clear towers if no wall

    let blocksToSplit: Polygon[] = [outline];
    let finalBlocks: Polygon[] = [];

    // 1. Recursive Block Splitting (Streets - Radial & Concentric)
    const targetBlockArea = 0.15 + Math.random() * 0.1; // Smaller blocks for denser city
    const attemptsBeforeGivingUp = 15;

    while (blocksToSplit.length > 0) {
      const block = blocksToSplit.pop()!;

      if (getArea(block) < targetBlockArea) {
        finalBlocks.push(block);
        continue;
      }

      let splitSuccess = false;
      for (let a = 0; a < attemptsBeforeGivingUp; a++) {
        const centroid = getCentroid(block);
        // Introduce slight variance
        const splitPoint = {
          x: centroid.x + (Math.random() - 0.5) * 0.2,
          y: centroid.y + (Math.random() - 0.5) * 0.2,
        };

        // Determine split direction: radial vs concentric
        // Radial: ray from city center to block centroid
        const dxCenter = centroid.x - cityCenter.x;
        const dyCenter = centroid.y - cityCenter.y;
        const distCenter = Math.hypot(dxCenter, dyCenter);

        let dir: Point;
        if (distCenter < 0.01) {
          // At exact center, just pick random
          const a = Math.random() * Math.PI * 2;
          dir = { x: Math.cos(a), y: Math.sin(a) };
        } else {
          const radialNormal = {
            x: dxCenter / distCenter,
            y: dyCenter / distCenter,
          };
          const concentricNormal = { x: -radialNormal.y, y: radialNormal.x };

          // 60% chance of concentric split, 30% radial, 10% random (for organic noise)
          const r = Math.random();
          if (r < 0.6) {
            dir = concentricNormal;
          } else if (r < 0.9) {
            dir = radialNormal;
          } else {
            const angle = Math.random() * Math.PI * 2;
            dir = { x: Math.cos(angle), y: Math.sin(angle) };
          }

          // Add slight noise to direction
          const noiseAngle = (Math.random() - 0.5) * 0.4;
          const currentAngle = Math.atan2(dir.y, dir.x);
          dir = {
            x: Math.cos(currentAngle + noiseAngle),
            y: Math.sin(currentAngle + noiseAngle),
          };
        }

        const res = splitPolygon(block, splitPoint, dir);
        if (res) {
          blocksToSplit.push(res[0], res[1]);
          splitSuccess = true;
          break;
        }
      }
      if (!splitSuccess) {
        finalBlocks.push(block);
      }
    }

    const cityBlocks: CityBlock[] = [];

    // 2. Shrink blocks to form roads, determine districts, generate terraced houses
    for (const rawBlock of finalBlocks) {
      const roadMargin = 0.05 + Math.random() * 0.03; // Narrower medieval streets

      const streetBlock = shrinkPolygon(rawBlock, roadMargin);
      if (getArea(streetBlock) < 0.02) continue; // Too small
      if (isPolygonInWater(streetBlock, ctx)) continue;

      const blockCentroid = getCentroid(streetBlock);
      const distToCenter = getDistance(blockCentroid, cityCenter);

      // District assignment logic
      let district: DistrictType = DistrictType.RESIDENTIAL;
      let touchesWater = false;
      for (const p of streetBlock) {
        if (
          isVisuallyWater(
            p.x + (blockCentroid.x - p.x) * 0.2,
            p.y + (blockCentroid.y - p.y) * 0.2,
            ctx,
          )
        ) {
          touchesWater = true;
          break;
        }
      }

      if (touchesWater) {
        district = DistrictType.HARBOR;
      } else if (distToCenter < maxRadius * 0.25) {
        district =
          Math.random() > 0.5 ? DistrictType.CASTLE : DistrictType.MARKET;
      } else if (distToCenter < maxRadius * 0.5) {
        district = DistrictType.WEALTHY;
      } else if (distToCenter > maxRadius * 0.75) {
        district = DistrictType.SLUM;
      }

      let parcelsToSplit = [streetBlock];
      let finalBuildings: Building[] = [];
      const targetBuildingArea = 0.0005 + Math.random() * 0.001; // Smaller house footprints

      while (parcelsToSplit.length > 0) {
        const parcel = parcelsToSplit.pop()!;
        if (getArea(parcel) < targetBuildingArea) {
          // Terraced housing: extremely small margin so they almost touch!
          const houseSpacing = district === DistrictType.SLUM ? 0.001 : 0.003;
          const finishedBuilding = shrinkPolygon(parcel, houseSpacing);

          if (!isPolygonInWater(finishedBuilding, ctx)) {
            finalBuildings.push({ polygon: finishedBuilding });
          }
          continue;
        }

        // Split building lot perpendicular to longest edge to get rectangular terraced houses
        let longestEdgeIdx = 0;
        let maxLenSq = 0;
        for (let i = 0; i < parcel.length; i++) {
          const p1 = parcel[i];
          const p2 = parcel[(i + 1) % parcel.length];
          const lSq = (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2;
          if (lSq > maxLenSq) {
            maxLenSq = lSq;
            longestEdgeIdx = i;
          }
        }

        const pe1 = parcel[longestEdgeIdx];
        const pe2 = parcel[(longestEdgeIdx + 1) % parcel.length];
        const dx = pe2.x - pe1.x;
        const dy = pe2.y - pe1.y;
        const len = Math.hypot(dx, dy);

        const dir = { x: -dy / len, y: dx / len }; // Perpendicular normal
        const centroid = getCentroid(parcel);

        // Offset split for varying terrace sizes
        const offset = (Math.random() - 0.5) * 0.4 * len;

        // Occasionally, leave an empty lot for a courtyard (unless slum)
        const isCourtyard =
          district !== DistrictType.SLUM && Math.random() < 0.15;

        if (isCourtyard && parcelsToSplit.length > 0) {
          // don't split, just leave it as courtyard by not adding houses
          continue;
        }

        const splitPoint = {
          x: centroid.x + (dx / len) * offset,
          y: centroid.y + (dy / len) * offset,
        };

        const res = splitPolygon(parcel, splitPoint, dir);

        if (res) {
          parcelsToSplit.push(res[0], res[1]);
        } else {
          // Fallback if split fails
          const houseSpacing = district === DistrictType.SLUM ? 0.001 : 0.003;
          const finishedBuilding = shrinkPolygon(parcel, houseSpacing);
          if (!isPolygonInWater(finishedBuilding, ctx)) {
            finalBuildings.push({ polygon: finishedBuilding });
          }
        }
      }

      if (finalBuildings.length > 0) {
        cityBlocks.push({
          polygon: streetBlock,
          buildings: finalBuildings,
          district,
        });
      }
    }

    city.geometry = {
      outline,
      innerRoads: [],
      blocks: cityBlocks,
      hasWall,
      towers,
    };
  }
}
