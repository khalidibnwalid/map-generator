import { MapGenerator } from "../game/MapGenerator";
import type { Preset } from "../game/MapGenerator";
import { CanvasManager } from "../core/CanvasManager";
import { GPURenderer } from "../core/GPURenderer";
import { TooltipManager } from "./TooltipManager";
import { LabelRenderer } from "./LabelRenderer";
import { NationsManager } from "./NationsManager";
import { UIManager } from "./UIManager";
import { CityRenderer } from "./CityRenderer";
import type { Point } from "../game/WorldData";

export type ViewLayer =
  | "Biomes"
  | "Elevation"
  | "Heatmap"
  | "Moisture"
  | "Nations"
  | "Borders";

export class Interface {
  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private activeLayers = {
    biomes: true,
    elevation: false,
    heatmap: false,
    moisture: false,
    nations: true,
    borders: true,
    provinces: true,
    roads: true,
    labels: true,
    cities: true,
  };
  private activeTab: "generate" | "layers" | "nations" = "generate";

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
      this.uiManager = new UIManager();
      this.nationsManager = new NationsManager(
        this.generator,
        this.canvasManager,
        this.gpuRenderer,
        this.uiManager,
      );
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
          this.nationsManager.nationsStateDirty = true;
          this.uiManager.hideLoadingModal();
          this.gpuRenderer.updateProvincesDataTexture(world);
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
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      if (
        this.nationsManager.cityPlacementMode !== -1 ||
        this.nationsManager.provincePlacementMode !== -1 ||
        this.nationsManager.nationPlacementMode
      ) {
        this.canvasManager.canvas.style.cursor = "crosshair";
        this.updateTooltipBar();
      } else if (
        this.activeLayers.nations &&
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
        this.canvasManager.scheduleRender(); // Force overlay update
      }
    });

    canvas.addEventListener("click", (e) => {
      const world = this.generator.getWorld();
      const cm = this.canvasManager;
      const rect = cm.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const wx = Math.floor((sx - cm.offsetX) / cm.scale);
      const wy = Math.floor((sy - cm.offsetY) / cm.scale);
      const x = ((wx % world.width) + world.width) % world.width;

      if (this.nationsManager.nationPlacementMode) {
        if (wy >= 0 && wy < world.height) {
          (async () => {
            await this.nationsManager.addNation(x, wy);
            this.updateTooltipBar();
          })();
        }
      } else if (this.nationsManager.provincePlacementMode !== -1) {
        if (wy >= 0 && wy < world.height) {
          (async () => {
            await this.nationsManager.addProvince(
              this.nationsManager.provincePlacementMode,
              x,
              wy,
            );
            this.updateTooltipBar();
          })();
        }
      } else if (this.nationsManager.cityPlacementMode !== -1) {
        if (wy >= 0 && wy < world.height) {
          (async () => {
            await this.nationsManager.addCity(
              this.nationsManager.cityPlacementMode,
              x,
              wy,
            );
            this.updateTooltipBar();
          })();
        }
      }
    });

    canvas.addEventListener("mousedown", (e) => {
      if (
        this.activeTab === "nations" &&
        this.nationsManager.isEditingNations &&
        e.button === 0 &&
        !e.shiftKey
      ) {
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
          // Use a slightly more generous check for picking to ensure we can hit coastlines
          if (
            cell.elevation >= 0.4 &&
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
      if (this.activeLayers.nations) {
        this.nationsManager.hoveredNationIndex = -1;
        this.tooltipManager.hide();
        this.canvasManager.scheduleRender();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (
        e.key === "Shift" &&
        this.nationsManager.isEditingNations &&
        this.canvasManager.canvas.style.cursor !== "grabbing"
      ) {
        this.canvasManager.canvas.style.cursor = "grab";
      }
    });

    window.addEventListener("keyup", (e) => {
      if (e.key === "Shift" && this.nationsManager.isEditingNations) {
        this.canvasManager.canvas.style.cursor = "default";
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

    // --- Tab Handling ---
    const tabs = ["generate", "layers", "nations"] as const;
    tabs.forEach((tab) => {
      const btn = document.getElementById(`tab-${tab}`);
      const content = document.getElementById(`content-${tab}`);
      if (btn && content) {
        btn.addEventListener("click", () => {
          this.activeTab = tab;
          tabs.forEach((t) => {
            document.getElementById(`tab-${t}`)?.classList.remove("active");
            document.getElementById(`content-${t}`)?.classList.remove("active");
          });
          btn.classList.add("active");
          content.classList.add("active");
          if (tab === "nations") this.nationsManager.renderList();
        });
      }
    });

    // --- Base Layer (Radios) ---
    const baseRadios = document.querySelectorAll('input[name="base-layer"]');
    baseRadios.forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const val = (e.target as HTMLInputElement).value;
        this.activeLayers.biomes = val === "Biomes";
        this.activeLayers.elevation = val === "Elevation";
        this.canvasManager.scheduleRender();
      });
    });

    // --- Overlays (Checkboxes) ---
    const overlays = [
      "nations",
      "borders",
      "heatmap",
      "moisture",
      "roads",
      "cities",
      "provinces",
      "labels",
    ] as const;
    overlays.forEach((overlay) => {
      const cb = document.getElementById(
        `layer-${overlay}`,
      ) as HTMLInputElement;
      if (cb) {
        cb.addEventListener("change", () => {
          (this.activeLayers as any)[overlay] = cb.checked;
          this.canvasManager.scheduleRender();
        });
      }
    });

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

          // Force Nations layer ON when editing
          this.activeLayers.nations = true;
          this.activeLayers.borders = true;
          const cb = document.getElementById(
            "layer-nations",
          ) as HTMLInputElement;
          const cbB = document.getElementById(
            "layer-borders",
          ) as HTMLInputElement;
          if (cb) cb.checked = true;
          if (cbB) cbB.checked = true;

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
    const brushInput = document.getElementById(
      "brush-size-input",
    ) as HTMLInputElement;

    if (brushSlider && brushInput) {
      const updateBrush = (val: number) => {
        this.nationsManager.brushSize = val;
        brushSlider.value = val.toString();
        brushInput.value = val.toString();
        this.canvasManager.scheduleRender();
      };

      brushSlider.addEventListener("input", () => {
        updateBrush(parseInt(brushSlider.value));
      });

      brushInput.addEventListener("change", () => {
        let val = parseInt(brushInput.value);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 100) val = 100;
        updateBrush(val);
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
        this.gpuRenderer.updateProvincesDataTexture(world);
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

    if (this.activeLayers.nations || this.activeLayers.borders) {
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
      (this.activeLayers.nations || this.activeLayers.borders) &&
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
      this.activeLayers,
      hoverColor,
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.gpuCanvas, 0, 0);

    // 1. Render Nation Capitals Circles (at low zoom)
    if (
      (this.activeLayers.nations || this.activeLayers.borders) &&
      scale < 10
    ) {
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

    if (this.activeLayers.cities) {
      this.cityRenderer.render(
        ctx,
        world,
        width,
        height,
        scale,
        offsetX,
        offsetY,
      );
    }

    // 3. Render World Roads (AFTER city geometry for better connectivity)
    if (
      this.activeLayers.roads &&
      world.worldRoads &&
      world.worldRoads.length > 0
    ) {
      ctx.save();
      const mapPixelWidth = world.width * scale;
      const startCopy = Math.floor(-offsetX / mapPixelWidth);
      const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);

      // Pre-smooth paths once per frame to avoid redundant O(N) work in the copy loop
      const smoothedRoads = world.worldRoads.map((road) => {
        let currentPath = road;
        const iterations = 1;
        for (let iter = 0; iter < iterations; iter++) {
          const smoothed: Point[] = [];
          if (currentPath.length < 3) return currentPath;
          smoothed.push(currentPath[0]);
          for (let i = 0; i < currentPath.length - 1; i++) {
            const p0 = currentPath[i];
            const p1 = currentPath[i + 1];

            let inCity = false;
            if (scale > 10) {
              for (const city of world.cities) {
                const cityRadius = city.isCapital
                  ? 2.5
                  : city.size === 1
                    ? 1.5
                    : 0.8;
                const dx0 = p0.x - city.x;
                const dy0 = p0.y - city.y;
                const dx1 = p1.x - city.x;
                const dy1 = p1.y - city.y;
                if (
                  dx0 * dx0 + dy0 * dy0 < cityRadius * cityRadius &&
                  dx1 * dx1 + dy1 * dy1 < cityRadius * cityRadius
                ) {
                  inCity = true;
                  break;
                }
              }
            }

            if (Math.abs(p0.x - p1.x) > world.width / 2 || inCity) {
              smoothed.push(p0, p1);
              continue;
            }
            smoothed.push({
              x: 0.75 * p0.x + 0.25 * p1.x,
              y: 0.75 * p0.y + 0.25 * p1.y,
            });
            smoothed.push({
              x: 0.25 * p0.x + 0.75 * p1.x,
              y: 0.25 * p0.y + 0.75 * p1.y,
            });
          }
          smoothed.push(currentPath[currentPath.length - 1]);
          currentPath = smoothed;
        }
        return currentPath;
      });

      const roadStrokeWidth = 0.6 + Math.pow(scale, 0.45) * 0.15;
      const casingWidth = roadStrokeWidth + 0.3 + Math.pow(scale, 0.4) * 0.1;

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (let copy = startCopy; copy <= endCopy; copy++) {
        const cxOffset = copy * world.width;

        // Pass 1: Casing
        ctx.strokeStyle = "rgba(40, 30, 20, 0.8)";
        ctx.lineWidth = casingWidth;
        for (const road of smoothedRoads) {
          if (road.length < 2) continue;
          ctx.beginPath();
          let pPrev = road[0];
          ctx.moveTo(
            (pPrev.x + cxOffset) * scale + offsetX,
            pPrev.y * scale + offsetY,
          );
          for (let i = 1; i < road.length; i++) {
            const p = road[i];
            if (Math.abs(p.x - pPrev.x) < world.width / 2) {
              ctx.lineTo(
                (p.x + cxOffset) * scale + offsetX,
                p.y * scale + offsetY,
              );
            } else {
              ctx.moveTo(
                (p.x + cxOffset) * scale + offsetX,
                p.y * scale + offsetY,
              );
            }
            pPrev = p;
          }
          ctx.stroke();
        }

        // Pass 2: Fill
        ctx.strokeStyle = "rgba(225, 210, 190, 1.0)";
        ctx.lineWidth = roadStrokeWidth;
        for (const road of smoothedRoads) {
          if (road.length < 2) continue;
          ctx.beginPath();
          let pPrev = road[0];
          ctx.moveTo(
            (pPrev.x + cxOffset) * scale + offsetX,
            pPrev.y * scale + offsetY,
          );
          for (let i = 1; i < road.length; i++) {
            const p = road[i];
            if (Math.abs(p.x - pPrev.x) < world.width / 2) {
              ctx.lineTo(
                (p.x + cxOffset) * scale + offsetX,
                p.y * scale + offsetY,
              );
            } else {
              ctx.moveTo(
                (p.x + cxOffset) * scale + offsetX,
                p.y * scale + offsetY,
              );
            }
            pPrev = p;
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (this.activeLayers.labels) {
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
    }

    // --- Brush Overlay ---
    if (
      this.nationsManager.isEditingNations &&
      !this.canvasManager.isInteracting &&
      !this.tooltipManager.isVisible
    ) {
      const rect = this.canvasManager.canvas.getBoundingClientRect();
      // We need the latest mouse position. Since we don't have it here,
      // let's ensure we track it in setupEventListeners or use a local variable.
      if (this.lastMouseX !== undefined && this.lastMouseY !== undefined) {
        const sx = this.lastMouseX - rect.left;
        const sy = this.lastMouseY - rect.top;

        ctx.save();
        ctx.beginPath();
        const radius = (this.nationsManager.brushSize * scale) / 2;
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0, 255, 170, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.stroke();

        // Inner solid circle
        ctx.beginPath();
        ctx.arc(sx, sy, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 255, 170, 0.8)";
        ctx.fill();
        ctx.restore();
      }
    }

    this.updateMapRuler(scale);
    this.renderMapIndicators();
  }

  private lastMouseX: number | undefined;
  private lastMouseY: number | undefined;

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

  private updateTooltipBar() {
    const overlay = document.getElementById("tooltip-bar");
    if (!overlay) return;

    if (this.nationsManager.nationPlacementMode) {
      overlay.textContent = "CREATING NEW NATION... (CLICK ON MAP)";
      overlay.style.display = "block";
    } else if (this.nationsManager.cityPlacementMode !== -1) {
      const nation =
        this.generator.getWorld().nations[
          this.nationsManager.cityPlacementMode
        ];
      overlay.textContent = `CREATING NEW CITY FOR ${nation?.name.toUpperCase()}... (CLICK ON MAP)`;
      overlay.style.display = "block";
    } else {
      overlay.style.display = "none";
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
        cell.elevation >= 0.4 &&
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
  private renderMapIndicators() {
    // Remove existing indicators
    document
      .querySelectorAll(".map-loading-indicator")
      .forEach((el) => el.remove());

    const world = this.generator.getWorld();
    const cm = this.canvasManager;

    this.nationsManager.pendingCityIds.forEach((cityId) => {
      const city = world.cities[cityId];
      if (!city) return;

      // Calculate screen position
      const sx = city.x * cm.scale + cm.offsetX;
      const sy = city.y * cm.scale + cm.offsetY;

      // Create indicator
      const indicator = document.createElement("div");
      indicator.className = "map-loading-indicator";
      indicator.style.left = `${sx}px`;
      indicator.style.top = `${sy}px`;

      const label = document.createElement("div");
      label.className = "map-loading-label";
      label.innerHTML = `<span class="spinner"></span> Founding ${city.name.toUpperCase()}...`;
      indicator.appendChild(label);

      document.body.appendChild(indicator);
    });
  }
}
