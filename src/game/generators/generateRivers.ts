import type { GeneratorContext } from "./types";

export async function generateRivers(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width, height, onProgress } = ctx;
  // Basic hydrological carving
  const numRivers = Math.floor((width * height) / 5000);
  world.rivers = []; // Clear rivers

  const maxRiverLen = Math.floor(100 * (width / 800));

  for (let r = 0; r < numRivers; r++) {
    // Yield every 5 rivers for UI responsiveness and detailed progress
    if (r % 5 === 0) {
      onProgress?.((r / numRivers) * 100);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    let x = Math.floor(noise.random() * width);
    let y = Math.floor(noise.random() * height);

    let cell = world.grid[x][y];
    // Start river only in mountains or high elevation
    if (cell.isWater || cell.elevation < 0.6) continue;

    let len = 0;
    let currentRiver: { x: number; y: number }[] = [];

    while (len < maxRiverLen) {
      cell.hasRiver = true;
      currentRiver.push({ x, y });

      let lowestNeighbor = null;
      let minElev = cell.elevation;
      let nextX = x,
        nextY = y;

      // Check 8 neighbors
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          let ny = y + dy;
          if (ny >= 0 && ny < height) {
            let nx = (((x + dx) % width) + width) % width;
            const nCell = world.grid[nx][ny];
            if (nCell.elevation < minElev) {
              minElev = nCell.elevation;
              lowestNeighbor = nCell;
              nextX = nx;
              nextY = ny;
            }
          }
        }
      }

      if (lowestNeighbor) {
        x = nextX;
        y = nextY;
        cell = lowestNeighbor;
        if (cell.isWater) {
          // River reached ocean
          currentRiver.push({ x, y });
          break;
        }
      } else {
        // River trapped in depression (lake)
        break;
      }
      len++;
    }

    if (currentRiver.length > 2) {
      world.rivers.push(currentRiver);
      carveRiver(ctx, currentRiver);
    }
  }
}

function carveRiver(ctx: GeneratorContext, path: { x: number; y: number }[]) {
  const { world, width, height } = ctx;

  // helper to get distance from point to segment
  const distToSegment = (
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
  };

  path.forEach((point, index) => {
    if (index === 0) return;
    const prev = path[index - 1];

    // Progress along the river
    const progress = index / path.length;
    // Radius: significantly reduced for "thin rivers"
    // Starting at 0.6 to minimize the "beads" at source while keeping it narrow.
    const radius = 0.6 + progress * 0.9;
    const depth = 0.4; // Sharper threshold for water biome

    // Calculate bounding box for the segment to optimize search
    const minX = Math.floor(Math.min(point.x, prev.x) - radius);
    const maxX = Math.ceil(Math.max(point.x, prev.x) + radius);
    const minY = Math.floor(Math.min(point.y, prev.y) - radius);
    const maxY = Math.ceil(Math.max(point.y, prev.y) + radius);

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const nx = ((px % width) + width) % width;
        const ny = py;

        if (ny >= 0 && ny < height) {
          // Check distance to the segment between prev and current point
          const dist = distToSegment(px, py, prev.x, prev.y, point.x, point.y);

          if (dist <= radius) {
            const cell = world.grid[nx][ny];
            // Weight with even SHARPER falloff (power of 3)
            // This makes the underwater "river bed" very thin.
            const weight = 1.0 - dist / radius;
            const carvingWeight = Math.pow(weight, 3.0);

            // Apply carving
            const targetElev =
              cell.elevation - (cell.elevation - depth) * carvingWeight;
            cell.elevation = Math.min(cell.elevation, targetElev);

            if (cell.elevation < 0.45) {
              cell.isWater = true;
            }
            cell.hasRiver = true;
          }
        }
      }
    }
  });
}
