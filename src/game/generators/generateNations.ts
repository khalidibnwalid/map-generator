import type { GeneratorContext } from "./types";

export async function generateNations(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width, height, onProgress } = ctx;
  world.nations = [];

  // Base number of nations based on map scale
  const numNations = Math.floor((width * height) / 12000);

  const names = [
    "Aethelgard",
    "Vanguard",
    "Karak",
    "Zion",
    "Oblivion",
    "Nebula",
    "Cynosure",
    "Dominion",
    "Republic of Terra",
    "Empire of the Sun",
    "Zenith",
    "Apex",
    "Nadir",
    "Horizon",
    "Meridian",
    "Equinox",
    "Solstice",
    "Oasis",
    "Sanctuary",
    "Bastion",
    "Citadel",
    "Aegis",
    "Vortex",
  ];

  // 1. Pick Capitals
  let capitalAttempts = 0;
  while (world.nations.length < numNations && capitalAttempts < 2000) {
    if (capitalAttempts % 100 === 0) {
      onProgress?.((capitalAttempts / 2000) * 20); // 0-20% sub-progress for capitals
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const x = Math.floor(noise.random() * width);
    const y = Math.floor(noise.random() * height);
    const cell = world.grid[x][y];

    if (!cell.isWater && cell.elevation < 0.7) {
      let tooClose = false;
      for (const n of world.nations) {
        let dx = Math.abs(x - n.capitalX);
        if (dx > width / 2) dx = width - dx;
        const dy = Math.abs(y - n.capitalY);
        const minDistance = 40 * (width / 800);
        if (Math.hypot(dx, dy) < minDistance) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        const hue = Math.floor(noise.random() * 360);
        const s = 0.8;
        const l = 0.6;
        const k = (n: number) => (n + hue / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n: number) =>
          l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        const toHex = (c: number) => {
          const hex = Math.round(c * 255).toString(16);
          return hex.length === 1 ? "0" + hex : hex;
        };
        const colorHex = `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
        let name = names[Math.floor(noise.random() * names.length)];
        const suffix =
          String.fromCharCode(65 + Math.floor(noise.random() * 26)) +
          String.fromCharCode(65 + Math.floor(noise.random() * 26));
        name = `${name}-${suffix}`;

        world.nations.push({
          id: world.nations.length,
          name,
          color: colorHex,
          capitalX: x,
          capitalY: y,
        });
      }
    }
    capitalAttempts++;
  }

  // 2. Expand Borders
  const invResScale = 800 / width;
  for (let x = 0; x < width; x++) {
    if (x % 50 === 0) {
      onProgress?.(20 + (x / width) * 60); // 20-80% sub-progress for expansion
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    for (let y = 0; y < height; y++) {
      const cell = world.grid[x][y];
      // Remove water check to allow full map coverage for noisy coastlines
      // if (cell.isWater) continue;

      let minScore = Infinity;
      let closestNation = -1;
      const noiseScale = 0.02 * invResScale;
      const noiseStrength = 25 * (width / 800);
      const noiseX =
        noise.fbmCylinder(x, y, width, 4, 0.5, 2.0, noiseScale) * noiseStrength;
      const noiseY =
        noise.fbmCylinder(x + 5000, y + 5000, width, 4, 0.5, 2.0, noiseScale) *
        noiseStrength;

      const px = x + noiseX;
      const py = y + noiseY;

      for (const n of world.nations) {
        let dx = Math.abs(px - n.capitalX);
        while (dx > width) dx -= width;
        if (dx > width / 2) dx = width - dx;
        let dy = py - n.capitalY;
        let dist = Math.hypot(dx, dy);
        if (dist < minScore) {
          minScore = dist;
          closestNation = n.id;
        }
      }
      cell.nationIndex = closestNation;
    }
  }

  // 3. Pre-compute border flags
  for (let x = 0; x < width; x++) {
    if (x % 100 === 0) {
      onProgress?.(80 + (x / width) * 20); // 80-100% sub-progress for borders
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    for (let y = 0; y < height; y++) {
      const cell = world.grid[x][y];
      if (
        cell.isWater ||
        cell.nationIndex === undefined ||
        cell.nationIndex < 0
      ) {
        cell.isNationBorder = false;
        continue;
      }
      const nid = cell.nationIndex;
      let border = false;
      outerLoop: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy;
          const nx = (((x + dx) % width) + width) % width;
          if (ny >= 0 && ny < height) {
            const nb = world.grid[nx][ny];
            if (nb.isWater || (nb.nationIndex ?? -1) !== nid) {
              border = true;
              break outerLoop;
            }
          }
        }
      }
      cell.isNationBorder = border;
    }
  }
}
