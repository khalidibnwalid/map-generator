import type { MapGenerator } from "../game/MapGenerator";
import type { CanvasManager } from "../core/CanvasManager";
import type { GPURenderer } from "../core/GPURenderer";

export class NationsManager {
  public hoveredNationIndex: number = -1;
  public selectedNationIndex: number = -1;
  public isEditingNations: boolean = false;
  public isPainting: boolean = false;
  public brushSize: number = 2;
  public nationCellsList: number[][] = [];
  public nationCentroids: { x: number; y: number }[] = [];
  public nationSizes: number[] = [];
  public nationsStateDirty: boolean = true;

  private lastPaintedX: number | null = null;
  private lastPaintedY: number | null = null;

  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private gpuRenderer: GPURenderer;

  constructor(
    generator: MapGenerator,
    canvasManager: CanvasManager,
    gpuRenderer: GPURenderer,
  ) {
    this.generator = generator;
    this.canvasManager = canvasManager;
    this.gpuRenderer = gpuRenderer;
  }

  public renderList() {
    if (document.activeElement?.classList.contains("nation-name-input")) return;

    const listContainer = document.getElementById("nations-list");
    if (!listContainer) return;

    const world = this.generator.getWorld();
    listContainer.innerHTML = "";

    world.nations.forEach((nation, idx) => {
      const item = document.createElement("div");
      item.className = `nation-item ${this.selectedNationIndex === idx ? "selected" : ""}`;
      item.dataset.index = idx.toString();

      const swatchContainer = document.createElement("div");
      swatchContainer.className = "nation-color-swatch-container";

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.className = "nation-color-input";
      colorInput.value = nation.color;
      colorInput.addEventListener("input", (e) => {
        nation.color = (e.target as HTMLInputElement).value;
        swatchContainer.style.backgroundColor = nation.color;
        this.nationsStateDirty = true;
        this.canvasManager.scheduleRender();
      });
      colorInput.addEventListener("mousedown", (e) => e.stopPropagation());
      colorInput.addEventListener("click", (e) => e.stopPropagation());

      swatchContainer.style.backgroundColor = nation.color;
      swatchContainer.appendChild(colorInput);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "nation-name-input";
      nameInput.value = nation.name;
      nameInput.addEventListener("change", (e) => {
        nation.name = (e.target as HTMLInputElement).value;
        this.canvasManager.scheduleRender();
      });
      nameInput.addEventListener("mousedown", (e) => e.stopPropagation());
      nameInput.addEventListener("click", (e) => e.stopPropagation());

      const territoryCount = document.createElement("span");
      territoryCount.className = "nation-territory-count";
      const areaPx = this.nationCellsList[idx]?.length || 0;
      // 1 px = 5km, so 1 px² = 25 km²
      const areaKm2 = areaPx * 25;
      territoryCount.textContent = `${areaKm2.toLocaleString()} km²`;

      item.appendChild(swatchContainer);
      item.appendChild(nameInput);
      item.appendChild(territoryCount);

      item.addEventListener("click", () => {
        this.selectedNationIndex = idx;
        this.renderList();
      });

      item.addEventListener("mouseenter", () => {
        if (this.isPainting) return;
        this.hoveredNationIndex = idx;
        this.canvasManager.scheduleRender();
      });

      item.addEventListener("mouseleave", () => {
        if (this.isPainting) return;
        this.hoveredNationIndex = -1;
        this.canvasManager.scheduleRender();
      });

      listContainer.appendChild(item);
    });
  }

  public handlePainting(clientX: number, clientY: number) {
    if (!this.isPainting || this.selectedNationIndex === -1) return;

    const cm = this.canvasManager;
    const rect = cm.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    const wx = Math.floor((sx - cm.offsetX) / cm.scale);
    const wy = Math.floor((sy - cm.offsetY) / cm.scale);

    if (this.lastPaintedX === null || this.lastPaintedY === null) {
      this.paintAt(wx, wy);
    } else {
      const dx = wx - this.lastPaintedX;
      const dy = wy - this.lastPaintedY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
      for (let i = 0; i <= steps; i++) {
        const px = Math.floor(this.lastPaintedX + (dx * i) / steps);
        const py = Math.floor(this.lastPaintedY + (dy * i) / steps);
        this.paintAt(px, py);
      }
    }

    this.lastPaintedX = wx;
    this.lastPaintedY = wy;

    this.gpuRenderer.updateNationsDataTexture(this.generator.getWorld());
    this.canvasManager.scheduleRender();
    this.renderList();
  }

  public stopPainting() {
    if (this.isPainting) {
      this.isPainting = false;
      this.lastPaintedX = null;
      this.lastPaintedY = null;
      this.updateStatistics();
      this.canvasManager.scheduleRender();
    }
  }

  private paintAt(wx: number, wy: number) {
    const world = this.generator.getWorld();
    const brushSize = this.brushSize;
    const radiusSq = (brushSize / 2) * (brushSize / 2);
    const offset = Math.floor(brushSize / 2);

    for (let dx = 0; dx < brushSize; dx++) {
      for (let dy = 0; dy < brushSize; dy++) {
        const lx = dx - offset;
        const ly = dy - offset;

        if (lx * lx + ly * ly > radiusSq + 0.25) continue;

        const tx = wx + lx;
        const ty = wy + ly;

        if (ty >= 0 && ty < world.height) {
          const wrappedX = ((tx % world.width) + world.width) % world.width;
          const cell = world.grid[wrappedX][ty];

          if (cell.nationIndex !== this.selectedNationIndex) {
            const oldIdx = cell.nationIndex ?? -1;
            cell.nationIndex = this.selectedNationIndex;

            if (oldIdx !== -1) {
              const oldList = this.nationCellsList[oldIdx];
              const flatIdx = ty * world.width + wrappedX;
              const listIdx = oldList.indexOf(flatIdx);
              if (listIdx > -1) oldList.splice(listIdx, 1);
            }
            this.nationCellsList[this.selectedNationIndex].push(
              ty * world.width + wrappedX,
            );

            this.updateLocalBorders(tx, ty);
          }
        }
      }
    }
  }

  private updateLocalBorders(wx: number, wy: number) {
    const world = this.generator.getWorld();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nwx = wx + dx;
        const nwy = wy + dy;

        if (nwy >= 0 && nwy < world.height) {
          const wrappedX = ((nwx % world.width) + world.width) % world.width;
          const cell = world.grid[wrappedX][nwy];
          if (cell.isWater) continue;

          let isBorder = false;
          const nid = cell.nationIndex;
          neighborLoop: for (let nxd = -1; nxd <= 1; nxd++) {
            for (let nyd = -1; nyd <= 1; nyd++) {
              if (nxd === 0 && nyd === 0) continue;
              const nnwx = nwx + nxd;
              const nnwy = nwy + nyd;
              if (nnwy >= 0 && nnwy < world.height) {
                const nnwrappedX =
                  ((nnwx % world.width) + world.width) % world.width;
                const nb = world.grid[nnwrappedX][nnwy];
                if (nb.isWater || (nb.nationIndex ?? -1) !== nid) {
                  isBorder = true;
                  break neighborLoop;
                }
              }
            }
          }
          cell.isNationBorder = isBorder;
        }
      }
    }
  }

  public buildCache() {
    const world = this.generator.getWorld();
    const W = world.width;
    const H = world.height;
    this.nationCellsList = world.nations.map(() => []);
    this.nationCentroids = world.nations.map(() => ({ x: 0, y: 0 }));
    this.nationSizes = world.nations.map(() => 0);

    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (
          !cell.isWater &&
          cell.nationIndex !== undefined &&
          cell.nationIndex >= 0
        ) {
          this.nationCellsList[cell.nationIndex].push(y * W + x);
          this.nationCentroids[cell.nationIndex].x += x;
          this.nationCentroids[cell.nationIndex].y += y;
        }
      }
    }

    this.updateStatistics();
  }

  public updateStatistics() {
    const world = this.generator.getWorld();
    const W = world.width;

    let maxArea = 0;
    for (let i = 0; i < world.nations.length; i++) {
      const cells = this.nationCellsList[i];
      const area = cells.length;
      if (area > maxArea) maxArea = area;

      if (area > 0) {
        let sumX = 0;
        let sumY = 0;
        for (const flatIdx of cells) {
          sumX += flatIdx % W;
          sumY += Math.floor(flatIdx / W);
        }
        this.nationCentroids[i] = { x: sumX / area, y: sumY / area };
      } else {
        this.nationCentroids[i] = {
          x: world.nations[i]?.capitalX || 0,
          y: world.nations[i]?.capitalY || 0,
        };
      }
    }

    for (let i = 0; i < world.nations.length; i++) {
      const area = this.nationCellsList[i].length;
      this.nationSizes[i] = maxArea > 0 ? Math.sqrt(area / maxArea) : 0.5;
    }
  }
}
