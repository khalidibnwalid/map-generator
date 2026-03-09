import type { MapGenerator } from "../game/MapGenerator";
import type { CanvasManager } from "../core/CanvasManager";
import type { GPURenderer } from "../core/GPURenderer";

export class NationsManager {
  public hoveredNationIndex: number = -1;
  public selectedNationIndex: number = -1;
  public isEditingNations: boolean = false;
  public isPainting: boolean = false;
  public brushSize: number = 2;
  public nationCellsList: Set<number>[] = [];
  public nationCentroids: { x: number; y: number }[] = [];
  public nationSizes: number[] = [];
  public nationsStateDirty: boolean = true;
  private expandedNations: Set<number> = new Set();
  private cityMap: Map<number, any> = new Map();

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

      const toggleBtn = document.createElement("button");
      toggleBtn.className = `nation-toggle-btn ${this.expandedNations.has(idx) ? "expanded" : ""}`;
      toggleBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M8.59,16.59L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.59Z"/>
        </svg>
      `;
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.expandedNations.has(idx)) {
          this.expandedNations.delete(idx);
        } else {
          this.expandedNations.add(idx);
        }
        this.renderList();
      });

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
      territoryCount.id = `nation-territory-count-${idx}`;
      const areaPx = this.nationCellsList[idx]?.size || 0;
      const areaKm2 = areaPx * 25;
      territoryCount.textContent = `${areaKm2.toLocaleString()} km²`;

      item.appendChild(toggleBtn);
      item.appendChild(swatchContainer);
      item.appendChild(nameInput);
      item.appendChild(territoryCount);

      item.addEventListener("click", () => {
        this.selectedNationIndex = idx;
        const target = world.nations[idx];
        if (target) {
          this.canvasManager.lookAt(target.capitalX, target.capitalY);
        }
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

      // Render city list if expanded
      const cityListContainer = document.createElement("div");
      cityListContainer.id = `city-list-container-${idx}`;
      listContainer.appendChild(cityListContainer);

      if (this.expandedNations.has(idx)) {
        this.renderCityList(idx, cityListContainer);
      }
    });
  }

  private renderCityList(idx: number, container: HTMLElement) {
    const world = this.generator.getWorld();
    container.innerHTML = "";
    container.className = "city-sub-list";

    const getPopulation = (city: any) => {
      const cell = world.getCell(city.x, city.y);
      const biome = cell?.biome || "Grassland";

      let base = 1000;
      if (city.size === 1) base = 15000;
      if (city.size === 2) base = 120000;
      if (city.isCapital) base *= 2.5;

      const multipliers: Record<string, number> = {
        "Snow": 0.05, "Tundra": 0.1, "Scorched": 0.02, "Bare": 0.1,
        "Subtropical Desert": 0.2, "Temperate Desert": 0.3,
        "Tropical Rain Forest": 0.4, "Marsh": 0.3,
        "Taiga": 0.5, "Shrubland": 0.7, "Savanna": 0.8,
        "Grassland": 1.2, "Temperate Deciduous Forest": 1.5,
        "Temperate Rain Forest": 1.0
      };

      const mult = multipliers[biome] || 1.0;
      const pop = base * mult * (0.8 + (city.id % 40) / 100);

      if (pop >= 1000000) return (pop / 1000000).toFixed(1) + "M";
      if (pop >= 1000) return (pop / 1000).toFixed(0) + "k";
      return Math.floor(pop).toString();
    };

    const nationCities = world.cities.filter((c) => c.nationIndex === idx);
    nationCities.sort((a, b) => b.size - a.size);

    nationCities.forEach((city) => {
      const cityItem = document.createElement("div");
      cityItem.className = `city-item ${city.isCapital ? "is-capital" : ""}`;

      const capitalBtn = document.createElement("button");
      capitalBtn.className = `city-capital-btn ${city.isCapital ? "active" : ""}`;
      capitalBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z"/>
        </svg>
      `;
      capitalBtn.title = city.isCapital ? "Capital City" : "Assign as Capital";
      capitalBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (city.isCapital) return;
        const oldCapital = nationCities.find(c => c.isCapital);
        if (oldCapital) oldCapital.isCapital = false;
        city.isCapital = true;
        const nation = world.nations[idx];
        if (nation) { nation.capitalX = city.x; nation.capitalY = city.y; }
        this.updateNationUI(idx);
        this.canvasManager.scheduleRender();
      });

      const nameInput = document.createElement("input");
      nameInput.className = "city-name-input";
      nameInput.value = city.name;
      nameInput.spellcheck = false;
      nameInput.addEventListener("change", (e) => {
        city.name = (e.target as HTMLInputElement).value;
        this.canvasManager.scheduleRender();
      });
      nameInput.addEventListener("mousedown", (e) => e.stopPropagation());
      nameInput.addEventListener("click", (e) => e.stopPropagation());

      const popInfo = document.createElement("span");
      popInfo.className = "city-pop-info";
      popInfo.textContent = getPopulation(city);

      const locateBtn = document.createElement("button");
      locateBtn.className = "city-locate-btn";
      locateBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M12,2c-4.42,0-8,3.58-8,8c0,5.25,8,12,8,12s8-6.75,8-12C20,5.58,16.42,2,12,2z M12,13c-1.66,0-3-1.34-3-3s1.34-3,3-3s3,1.34,3,3S13.66,13,12,13z"/>
        </svg>
      `;
      locateBtn.title = "Locate City";
      locateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.canvasManager.lookAt(city.x, city.y, Math.max(this.canvasManager.scale, 8));
      });

      cityItem.appendChild(capitalBtn);
      cityItem.appendChild(nameInput);
      cityItem.appendChild(popInfo);
      cityItem.appendChild(locateBtn);
      container.appendChild(cityItem);
    });

    if (nationCities.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.className = "city-empty-msg";
      emptyMsg.textContent = "No cities founded yet";
      container.appendChild(emptyMsg);
    }
  }

  private updateNationUI(idx: number) {
    if (idx < 0) return;
    const territoryCount = document.getElementById(
      `nation-territory-count-${idx}`,
    );
    if (territoryCount) {
      const areaPx = this.nationCellsList[idx]?.size || 0;
      const areaKm2 = areaPx * 25;
      territoryCount.textContent = `${areaKm2.toLocaleString()} km²`;
    }

    if (this.expandedNations.has(idx)) {
      const container = document.getElementById(`city-list-container-${idx}`);
      if (container) {
        this.renderCityList(idx, container);
      }
    }
  }

  private buildCityMap() {
    this.cityMap.clear();
    const world = this.generator.getWorld();
    world.cities.forEach(city => {
      const flatIdx = city.y * world.width + city.x;
      this.cityMap.set(flatIdx, city);
    });
  }

  public handlePainting(clientX: number, clientY: number) {
    if (!this.isPainting || this.selectedNationIndex === -1) return;

    // Ensure city map is built before painting starts
    if (this.cityMap.size === 0) {
      this.buildCityMap();
    }

    const cm = this.canvasManager;
    const rect = cm.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    const wx = Math.floor((sx - cm.offsetX) / cm.scale);
    const wy = Math.floor((sy - cm.offsetY) / cm.scale);

    const affectedCells = new Set<number>();
    const affectedNations = new Set<number>();
    affectedNations.add(this.selectedNationIndex);

    let minX = wx, maxX = wx, minY = wy, maxY = wy;

    const updateDirtyRect = (px: number, py: number) => {
      const bSize = this.brushSize;
      const offset = Math.floor(bSize / 2);
      minX = Math.min(minX, px - offset);
      maxX = Math.max(maxX, px + offset);
      minY = Math.min(minY, py - offset);
      maxY = Math.max(maxY, py + offset);
    };

    if (this.lastPaintedX === null || this.lastPaintedY === null) {
      updateDirtyRect(wx, wy);
      this.paintAt(wx, wy, affectedCells, affectedNations);
    } else {
      const dx = wx - this.lastPaintedX;
      const dy = wy - this.lastPaintedY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
      for (let i = 0; i <= steps; i++) {
        const px = Math.floor(this.lastPaintedX + (dx * i) / steps);
        const py = Math.floor(this.lastPaintedY + (dy * i) / steps);
        updateDirtyRect(px, py);
        this.paintAt(px, py, affectedCells, affectedNations);
      }
    }

    this.lastPaintedX = wx;
    this.lastPaintedY = wy;

    // Batch border updates
    this.updateBatchBorders(affectedCells);

    // Partial texture update with padding for bilinear neighbors
    const world = this.generator.getWorld();
    const padding = 2;
    const dirtyX = minX - padding;
    const dirtyY = minY - padding;
    const dirtyW = (maxX - minX + 1) + padding * 2;
    const dirtyH = (maxY - minY + 1) + padding * 2;

    if (dirtyW > 0 && dirtyH > 0) {
      this.gpuRenderer.updateNationsDataTexture(world, {
        x: dirtyX,
        y: dirtyY,
        w: dirtyW,
        h: dirtyH
      });
    }

    this.canvasManager.scheduleRender();
    affectedNations.forEach((idx) => this.updateNationUI(idx));
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

  private paintAt(wx: number, wy: number, affectedCells: Set<number>, affectedNations: Set<number>) {
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

            const flatIdx = ty * world.width + wrappedX;
            if (oldIdx !== -1) {
              this.nationCellsList[oldIdx].delete(flatIdx);
              affectedNations.add(oldIdx);
            }
            this.nationCellsList[this.selectedNationIndex].add(flatIdx);

            // Update city ownership if a city exists at this coordinate
            const city = this.cityMap.get(flatIdx);
            if (city) {
              city.nationIndex = this.selectedNationIndex;
            }

            // Mark for border update later
            for (let bdx = -1; bdx <= 1; bdx++) {
              for (let bdy = -1; bdy <= 1; bdy++) {
                const bwx = tx + bdx;
                const bwy = ty + bdy;
                if (bwy >= 0 && bwy < world.height) {
                  const bwWrappedX = ((bwx % world.width) + world.width) % world.width;
                  affectedCells.add(bwy * world.width + bwWrappedX);
                }
              }
            }
          }
        }
      }
    }
  }

  private updateBatchBorders(affectedCells: Set<number>) {
    const world = this.generator.getWorld();
    const W = world.width;
    const H = world.height;

    affectedCells.forEach(flatIdx => {
      const x = flatIdx % W;
      const y = Math.floor(flatIdx / W);
      const cell = world.grid[x][y];
      if (cell.isWater) return;

      let isBorder = false;
      const nid = cell.nationIndex;
      neighborLoop: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (ny >= 0 && ny < H) {
            const wrappedX = ((nx % W) + W) % W;
            const nb = world.grid[wrappedX][ny];
            if (nb.isWater || (nb.nationIndex ?? -1) !== nid) {
              isBorder = true;
              break neighborLoop;
            }
          }
        }
      }
      cell.isNationBorder = isBorder;
    });
  }


  public buildCache() {
    const world = this.generator.getWorld();
    const W = world.width;
    const H = world.height;
    this.nationCellsList = world.nations.map(() => new Set());
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
          this.nationCellsList[cell.nationIndex].add(y * W + x);
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
      const area = cells.size;
      if (area > maxArea) maxArea = area;

      if (area > 0) {
        let sumX = 0;
        let sumY = 0;
        cells.forEach((flatIdx) => {
          sumX += flatIdx % W;
          sumY += Math.floor(flatIdx / W);
        });
        this.nationCentroids[i] = { x: sumX / area, y: sumY / area };
      } else {
        this.nationCentroids[i] = {
          x: world.nations[i]?.capitalX || 0,
          y: world.nations[i]?.capitalY || 0,
        };
      }
    }

    for (let i = 0; i < world.nations.length; i++) {
      const area = this.nationCellsList[i].size;
      this.nationSizes[i] = maxArea > 0 ? Math.sqrt(area / maxArea) : 0.5;
    }
  }
}
