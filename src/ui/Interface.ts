import { MapGenerator } from "../game/MapGenerator";
import type { Preset } from "../game/MapGenerator";
import { CanvasManager } from "../core/CanvasManager";
import { GPURenderer } from "../core/GPURenderer";
import { TooltipManager } from "./TooltipManager";
import { LabelRenderer } from "./LabelRenderer";
import { NationsManager } from "./NationsManager";
import { UIManager } from "./UIManager";
import { CityRenderer } from "./CityRenderer";

export type ViewLayer =
  | "Biomes"
  | "Elevation"
  | "Heatmap"
  | "Moisture"
  | "Nations";

export class Interface {
  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private currentLayer: ViewLayer = "Biomes";
  private activeTab: "generate" | "nations" = "generate";

  // Sub-managers
  private tooltipManager!: TooltipManager;
  private labelRenderer!: LabelRenderer;
  private nationsManager!: NationsManager;
  private uiManager!: UIManager;
  private cityRenderer!: CityRenderer;

  // GPU rendering
  private gpuRenderer!: GPURenderer;
  private gpuCanvas: HTMLCanvasElement;

  constructor(generator: MapGenerator, canvasManager: CanvasManager) {
    this.generator = generator;
    this.canvasManager = canvasManager;

    // Initialize GPU Renderer with an offscreen canvas
    this.gpuCanvas = document.createElement("canvas");
    try {
      this.gpuRenderer = new GPURenderer(this.gpuCanvas);

      // Initialize Sub-managers
      this.tooltipManager = new TooltipManager();
      this.labelRenderer = new LabelRenderer();
      this.nationsManager = new NationsManager(
        this.generator,
        this.canvasManager,
        this.gpuRenderer,
      );
      this.uiManager = new UIManager();
      this.cityRenderer = new CityRenderer();

      console.log("Starting initial generation...");
      this.uiManager.showLoadingModal();
      this.generator
        .generate((pct) => {
          this.uiManager.updateLoadingModal(pct);
        })
        .then(() => {
          const world = this.generator.getWorld();
          this.gpuRenderer.updateWorldTexture(world);
          this.uiManager.hideLoadingModal();
          this.nationsManager.buildCache();
          this.canvasManager.scheduleRender();
        });
    } catch (e) {
      console.error("Failed to initialize GPURenderer:", e);
    }

    this.setupUI();
    this.canvasManager.onRender = this.renderMap.bind(this);

    this.setupEventListeners();
  }

  private setupEventListeners() {
    let mousedownX = 0;
    let mousedownY = 0;
    let isAttemptingPaint = false;

    const canvas = this.canvasManager.canvas;
    canvas.addEventListener("mousemove", (e) => {
      if (
        this.currentLayer === "Nations" &&
        !this.nationsManager.isEditingNations
      ) {
        this.updateHover(e.clientX, e.clientY);
      } else if (
        this.activeTab === "nations" &&
        this.nationsManager.isEditingNations
      ) {
        if (isAttemptingPaint && !this.nationsManager.isPainting) {
          const dist = Math.hypot(
            e.clientX - mousedownX,
            e.clientY - mousedownY,
          );
          if (dist > 3) {
            this.nationsManager.isPainting = true;
          }
        }
        if (this.nationsManager.isPainting) {
          this.nationsManager.handlePainting(e.clientX, e.clientY);
        }
      }
    });

    canvas.addEventListener("mousedown", (e) => {
      if (
        this.activeTab === "nations" &&
        this.nationsManager.isEditingNations &&
        e.button === 0
      ) {
        const world = this.generator.getWorld();
        const cm = this.canvasManager;
        const rect = cm.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const wx = Math.floor((sx - cm.offsetX) / cm.scale);
        const wy = Math.floor((sy - cm.offsetY) / cm.scale);
        const x = ((wx % world.width) + world.width) % world.width;

        if (wy >= 0 && wy < world.height) {
          const cell = world.grid[x][wy];
          if (cell.isWater) {
            this.nationsManager.isEditingNations = false;
            document
              .getElementById("btn-edit-nations")
              ?.parentElement?.classList.remove("edit-mode-active");
            this.canvasManager.panningLocked = false;
            this.canvasManager.canvas.style.cursor = "grab";
            this.canvasManager.scheduleRender();
            return;
          }
        }

        if (this.nationsManager.selectedNationIndex !== -1) {
          isAttemptingPaint = true;
          mousedownX = e.clientX;
          mousedownY = e.clientY;
        }
      }
    });

    canvas.addEventListener("dblclick", (e) => {
      if (
        this.activeTab === "nations" &&
        this.nationsManager.isEditingNations &&
        e.button === 0
      ) {
        isAttemptingPaint = false;
        this.nationsManager.isPainting = false;
        const world = this.generator.getWorld();
        const cm = this.canvasManager;
        const rect = cm.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const wx = Math.floor((sx - cm.offsetX) / cm.scale);
        const wy = Math.floor((sy - cm.offsetY) / cm.scale);
        const x = ((wx % world.width) + world.width) % world.width;

        if (wy >= 0 && wy < world.height) {
          const cell = world.grid[x][wy];
          if (
            !cell.isWater &&
            cell.nationIndex !== undefined &&
            cell.nationIndex !== -1 &&
            cell.nationIndex !== this.nationsManager.selectedNationIndex
          ) {
            this.nationsManager.selectedNationIndex = cell.nationIndex;
            this.nationsManager.isPainting = false;
            this.nationsManager.renderList();
            const target = document.querySelector(
              `.nation-item[data-index="${this.nationsManager.selectedNationIndex}"]`,
            );
            target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        }
      }
    });

    window.addEventListener("mouseup", () => {
      isAttemptingPaint = false;
      this.nationsManager.stopPainting();
    });

    canvas.addEventListener("mouseleave", () => {
      if (this.currentLayer === "Nations") {
        this.nationsManager.hoveredNationIndex = -1;
        this.tooltipManager.hide();
        this.canvasManager.scheduleRender();
      }
    });
  }

  private setupUI() {
    const seedInput = document.getElementById("seed") as HTMLInputElement;
    const generateBtn = document.getElementById(
      "generate",
    ) as HTMLButtonElement;
    const presetSelect = document.getElementById("preset") as HTMLSelectElement;
    const toggleBtn = document.getElementById(
      "toggle-panel",
    ) as HTMLButtonElement;
    const uiPanel = document.getElementById("ui-panel") as HTMLDivElement;

    if (toggleBtn && uiPanel) {
      toggleBtn.addEventListener("click", () => {
        uiPanel.classList.toggle("collapsed");
        toggleBtn.textContent = uiPanel.classList.contains("collapsed")
          ? "[+]"
          : "[-]";
      });
    }

    const layers = [
      "Biomes",
      "Elevation",
      "Heatmap",
      "Moisture",
      "Nations",
    ] as ViewLayer[];
    layers.forEach((layer) => {
      const btn = document.getElementById(`layer-${layer.toLowerCase()}`);
      if (btn) {
        btn.addEventListener("click", () => {
          this.currentLayer = layer;
          document
            .querySelectorAll(".layer-btn")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.canvasManager.scheduleRender();
        });
      }
    });

    const tabGenerate = document.getElementById("tab-generate");
    const tabNations = document.getElementById("tab-nations");
    const contentGenerate = document.getElementById("content-generate");
    const contentNations = document.getElementById("content-nations");

    if (tabGenerate && tabNations && contentGenerate && contentNations) {
      tabGenerate.addEventListener("click", () => {
        this.activeTab = "generate";
        tabGenerate.classList.add("active");
        tabNations.classList.remove("active");
        contentGenerate.classList.add("active");
        contentNations.classList.remove("active");
      });

      tabNations.addEventListener("click", () => {
        this.activeTab = "nations";
        tabNations.classList.add("active");
        tabGenerate.classList.remove("active");
        contentNations.classList.add("active");
        contentGenerate.classList.remove("active");
        this.nationsManager.renderList();
      });
    }

    const btnEditNations = document.getElementById(
      "btn-edit-nations",
    ) as HTMLButtonElement;
    if (btnEditNations) {
      btnEditNations.addEventListener("click", () => {
        this.nationsManager.isEditingNations =
          !this.nationsManager.isEditingNations;
        btnEditNations.parentElement?.classList.toggle(
          "edit-mode-active",
          this.nationsManager.isEditingNations,
        );

        if (this.nationsManager.isEditingNations) {
          this.canvasManager.panningLocked = true;
          this.canvasManager.canvas.style.cursor = "default";
          this.currentLayer = "Nations";
          document
            .querySelectorAll(".layer-btn")
            .forEach((b) => b.classList.remove("active"));
          document.getElementById("layer-nations")?.classList.add("active");
          this.canvasManager.scheduleRender();
        } else {
          this.canvasManager.panningLocked = false;
          this.canvasManager.canvas.style.cursor = "grab";
        }
      });
    }

    const brushSlider = document.getElementById(
      "brush-size",
    ) as HTMLInputElement;
    const brushValueDisp = document.getElementById("brush-size-value");
    if (brushSlider && brushValueDisp) {
      brushSlider.addEventListener("input", () => {
        this.nationsManager.brushSize = parseInt(brushSlider.value);
        brushValueDisp.textContent = this.nationsManager.brushSize.toString();
      });
    }

    seedInput.value = this.generator.currentSeed.toString();

    generateBtn.addEventListener("click", async () => {
      if (generateBtn.classList.contains("loading")) return;

      const p = presetSelect.value as Preset;
      const seedVal =
        parseInt(seedInput.value) || Math.floor(Math.random() * 999999);
      seedInput.value = seedVal.toString();

      let sizeChanged = false;
      let newW = this.generator.getWidth();
      let newH = this.generator.getHeight();
      const sizeSelect = document.getElementById("size") as HTMLSelectElement;
      if (sizeSelect) {
        const [w, h] = sizeSelect.value.split("x").map(Number);
        if (w !== newW || h !== newH) {
          sizeChanged = true;
          newW = w;
          newH = h;
        }
      }

      this.generator.currentPreset = p;
      this.generator.currentSeed = seedVal;

      if (sizeChanged) {
        this.generator.setSize(newW, newH);
        const fitScale = window.innerHeight / newH;
        this.canvasManager.scale = fitScale;
        this.canvasManager.offsetX = (window.innerWidth - newW * fitScale) / 2;
        this.canvasManager.offsetY = 0;
      }

      this.uiManager.setBtnLoading(true);
      const originalText = generateBtn.textContent || "Generate";

      try {
        this.uiManager.showLoadingModal();
        await this.generator.generate((pct) => {
          this.uiManager.setBtnProgress(pct);
          this.uiManager.updateLoadingModal(pct);
        });

        const world = this.generator.getWorld();
        this.gpuRenderer.updateWorldTexture(world);
        this.nationsManager.nationsStateDirty = true;
        this.nationsManager.hoveredNationIndex = -1;
        this.nationsManager.buildCache();
        this.uiManager.hideLoadingModal();
        this.canvasManager.scheduleRender();
      } finally {
        this.uiManager.setBtnLoading(false, originalText);
      }
    });
  }

  private renderMap(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    isInteracting: boolean,
  ) {
    const world = this.generator.getWorld();
    const minScale = height / world.height;
    if (this.canvasManager.scale < minScale) {
      this.canvasManager.scale = minScale;
      scale = minScale;
    }

    const mapPixelHeight = world.height * scale;
    if (this.canvasManager.offsetY > 0) {
      this.canvasManager.offsetY = 0;
      offsetY = 0;
    } else if (this.canvasManager.offsetY < height - mapPixelHeight) {
      this.canvasManager.offsetY = height - mapPixelHeight;
      offsetY = height - mapPixelHeight;
    }

    const layerMap: Record<ViewLayer, number> = {
      Biomes: 0,
      Elevation: 1,
      Heatmap: 2,
      Moisture: 3,
      Nations: 4,
    };

    if (this.currentLayer === "Nations") {
      if (this.nationsManager.nationsStateDirty) {
        this.nationsManager.buildCache();
        this.gpuRenderer.updateNationsDataTexture(world);
        this.nationsManager.nationsStateDirty = false;
      }
    }

    if (this.gpuCanvas.width !== width || this.gpuCanvas.height !== height) {
      this.gpuCanvas.width = width;
      this.gpuCanvas.height = height;
    }

    let hoverColor: number[] | undefined = undefined;
    if (
      this.currentLayer === "Nations" &&
      this.nationsManager.hoveredNationIndex >= 0 &&
      this.nationsManager.hoveredNationIndex < world.nations.length
    ) {
      const hColor = this.hexToRgb(
        world.nations[this.nationsManager.hoveredNationIndex].color,
      );
      hoverColor = [hColor[0] / 255, hColor[1] / 255, hColor[2] / 255];
    }

    this.gpuRenderer.render(
      width,
      height,
      world.width,
      world.height,
      scale,
      offsetX,
      offsetY,
      layerMap[this.currentLayer],
      hoverColor,
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.gpuCanvas, 0, 0);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    ctx.restore();

    ctx.restore();

    if (this.currentLayer === "Nations" && scale < 10) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      const mapPixelWidth = world.width * scale;
      const startCopy = Math.floor(-offsetX / mapPixelWidth);
      const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);
      const sortedCities = [...world.cities].sort((a, b) => a.size - b.size);

      for (const city of sortedCities) {
        const isHovered =
          city.nationIndex === this.nationsManager.hoveredNationIndex;
        const nation = world.nations[city.nationIndex];
        if (!nation) continue;

        ctx.globalAlpha = isHovered ? 1.0 : city.isCapital ? 0.7 : 0.4;

        for (let copy = startCopy; copy <= endCopy; copy++) {
          const cx = city.x + copy * world.width;
          const cy = city.y;
          const isCapital = city.isCapital;
          const radius = isCapital ? 1.3 : city.size === 1 ? 0.8 : 0.4;

          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fillStyle = "#FFFFFF";
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1.0;
      ctx.restore();
    }

    // Render World Roads
    if (world.worldRoads && world.worldRoads.length > 0) {
      ctx.save();
      const mapPixelWidth = world.width * scale;
      const startCopy = Math.floor(-offsetX / mapPixelWidth);
      const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);

      ctx.strokeStyle = "rgba(140, 110, 80, 0.7)";
      ctx.lineWidth = Math.max(1, scale * 0.15);
      // Round caps/joins for smoother looking roads
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (let copy = startCopy; copy <= endCopy; copy++) {
        const cxOffset = copy * world.width;

        ctx.beginPath();
        for (const road of world.worldRoads) {
          if (road.length === 0) continue;
          let first = true;
          for (let i = 0; i < road.length; i++) {
            const p = road[i];
            const px = (p.x + cxOffset) * scale + offsetX;
            const py = p.y * scale + offsetY;

            if (first) {
              ctx.moveTo(px, py);
              first = false;
            } else {
              const prev = road[i - 1];
              if (Math.abs(p.x - prev.x) > world.width / 2) {
                // Handle world wrap edge case by skipping the jump
                ctx.moveTo(px, py);
              } else {
                ctx.lineTo(px, py);
              }
            }
          }
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    this.cityRenderer.render(
      ctx,
      world,
      width,
      height,
      scale,
      offsetX,
      offsetY,
    );

    this.labelRenderer.render(
      ctx,
      world,
      width,
      height,
      scale,
      offsetX,
      offsetY,
      isInteracting,
      this.nationsManager.nationSizes,
      this.nationsManager.nationCentroids,
    );

    this.updateMapRuler(scale);
  }

  private updateMapRuler(scale: number) {
    // 1 cell (pixel) = 5 km
    const kmPerViewPixel = 5 / scale;
    const targetViewPixels = 300; // Increased to make the ruler wider on screen
    const targetKm = targetViewPixels * kmPerViewPixel;

    let magnitude = Math.pow(10, Math.floor(Math.log10(targetKm)));
    if (magnitude < 1) magnitude = 1;

    const normalized = targetKm / magnitude;
    let niceMultiplier;
    if (normalized < 2) niceMultiplier = 1;
    else if (normalized < 5) niceMultiplier = 2;
    else niceMultiplier = 5;

    const niceKm = niceMultiplier * magnitude;
    const actualViewPixels = niceKm / kmPerViewPixel;

    const rulerEl = document.getElementById("map-ruler");
    if (rulerEl) {
      rulerEl.style.display = "flex";
      const rulerLine = rulerEl.querySelector(".ruler-line") as HTMLElement;
      const rulerTextEnd = rulerEl.querySelector(
        "#ruler-text-end",
      ) as HTMLElement;
      const rulerTextMid = rulerEl.querySelector(
        "#ruler-text-mid",
      ) as HTMLElement;
      if (rulerLine && rulerTextEnd && rulerTextMid) {
        rulerLine.style.width = `${actualViewPixels}px`;
        const halfKm = niceKm / 2;

        const formatKm = (km: number) => {
          if (km >= 1000) {
            const thousands = km / 1000;
            return `${thousands % 1 === 0 ? thousands : thousands.toFixed(1)}k`;
          }
          return `${km}`;
        };

        rulerTextMid.textContent = formatKm(halfKm);
        rulerTextEnd.textContent = `${formatKm(niceKm)} km`;
      }
    }
  }

  private updateHover(clientX: number, clientY: number) {
    const world = this.generator.getWorld();
    const cm = this.canvasManager;
    const rect = cm.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const wx = Math.round((sx - cm.offsetX) / cm.scale);
    const wy = Math.round((sy - cm.offsetY) / cm.scale);
    const x = ((wx % world.width) + world.width) % world.width;
    let newHovered = -1;
    if (wy >= 0 && wy < world.height) {
      const cell = world.grid[x][wy];
      if (
        !cell.isWater &&
        cell.nationIndex !== undefined &&
        cell.nationIndex >= 0
      )
        newHovered = cell.nationIndex;
    }

    if (newHovered !== this.nationsManager.hoveredNationIndex) {
      this.nationsManager.hoveredNationIndex = newHovered;
      this.canvasManager.scheduleRender();

      document
        .querySelectorAll(".nation-item")
        .forEach((el) => el.classList.remove("hovered"));
      if (newHovered !== -1) {
        const item = document.querySelector(
          `.nation-item[data-index="${newHovered}"]`,
        );
        item?.classList.add("hovered");
      }
    }

    if (newHovered >= 0) {
      const nation = world.nations[newHovered];
      let nearestCity = null;
      let nearestDist = Infinity;
      for (const city of world.cities) {
        if (city.nationIndex !== newHovered) continue;
        let dx = Math.abs(wx - city.x);
        if (dx > world.width / 2) dx = world.width - dx;
        const dist = Math.hypot(dx, wy - city.y);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestCity = city;
        }
      }
      if (nearestCity && nearestDist < 10 / cm.scale) {
        this.tooltipManager.show(
          clientX,
          clientY,
          nearestCity.name,
          `${nearestCity.isCapital ? "♦ Capital" : nearestCity.size === 1 ? "● Town" : "· Village"} · ${nation.name}`,
        );
      } else {
        this.tooltipManager.show(
          clientX,
          clientY,
          nation.name,
          `${world.cities.filter((c) => c.nationIndex === newHovered && !c.isCapital).length} cities`,
        );
      }
    } else {
      this.tooltipManager.hide();
    }
  }

  private hexToRgb(hex: string): number[] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? [
          parseInt(result[1], 16),
          parseInt(result[2], 16),
          parseInt(result[3], 16),
        ]
      : [0, 0, 0];
  }
}
