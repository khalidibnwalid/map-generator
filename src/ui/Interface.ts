import { MapGenerator } from "../game/MapGenerator";
import type { Preset } from "../game/MapGenerator";
import { CanvasManager } from "../core/CanvasManager";
import { GPURenderer, type MapTheme, type ThematicMode } from "../core/GPURenderer";
import { TooltipManager } from "./TooltipManager";
import { LabelRenderer } from "./LabelRenderer";
import { NationsManager } from "./NationsManager";
import { UIManager } from "./UIManager";
import { CityRenderer } from "./CityRenderer";
import { NetworkRenderer } from "./NetworkRenderer";
import { PoiRenderer } from "./PoiRenderer";
import { nearestPoi, POI_LABELS } from "../game/generators/generatePOIs";
import { saveWorld, loadWorld } from "../game/WorldFile";
import { RESOURCE_INFO, WEALTH_TIERS } from "../game/generators/generateEconomy";
import { THEMES } from "./themes";
import { WorldData } from "../game/WorldData";
import { RELATION_COLORS } from "../game/generators/generateDiplomacy";

export type ViewLayer =
  | "Biomes"
  | "Elevation"
  | "Heatmap"
  | "Population"
  | "Moisture"
  | "Nations"
  | "Borders";

function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// People per km² for a normalized density value (rural + urban mix)
export function peoplePerKm2(d: number): number {
  return Math.round(2 + Math.pow(Math.max(0, d), 1.6) * 160);
}

export class Interface {
  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private activeLayers = {
    biomes: true,
    elevation: false,
    heatmap: false,
    population: false,
    moisture: false,
    nations: true,
    borders: true,
    provinces: true,
    ice: true,
    rivers: true,
    roads: true,
    pois: true,
    searoutes: true,
    currents: false,
    resources: true,
    labels: true,
    cities: true,
  };
  private activeTab: "generate" | "layers" | "nations" = "generate";
  private theme: MapTheme = "Realistic";
  private thematic: ThematicMode = "none";
  private thematicFocus = -2; // nation the diplomacy texture was built for

  // Sub-managers
  private tooltipManager!: TooltipManager;
  private labelRenderer!: LabelRenderer;
  private nationsManager!: NationsManager;
  private uiManager!: UIManager;
  private cityRenderer!: CityRenderer;
  private networkRenderer = new NetworkRenderer();
  private poiRenderer = new PoiRenderer();

  // GPU rendering
  private gpuRenderer!: GPURenderer;
  private gpuCanvas: HTMLCanvasElement;
  // Rivers, roads, lanes, resources and landmarks are drawn into this layer and
  // reused (transformed) while panning/zooming or when only hover changed.
  private vectorLayer = document.createElement("canvas");
  private vectorState: { scale: number; offX: number; offY: number; key: string } | null = null;

  constructor(generator: MapGenerator, canvasManager: CanvasManager) {
    this.generator = generator;
    this.canvasManager = canvasManager;

    // The WebGL terrain canvas lives in the page right under the 2D overlay,
    // so frames are composited by the browser instead of copied each frame
    this.gpuCanvas = document.createElement("canvas");
    this.gpuCanvas.id = "terrainCanvas";
    this.canvasManager.canvas.parentElement?.insertBefore(this.gpuCanvas, this.canvasManager.canvas);
    try {
      this.gpuRenderer = new GPURenderer(this.gpuCanvas);

      // Initialize Sub-managers
      this.tooltipManager = new TooltipManager();
      this.labelRenderer = new LabelRenderer();
      this.uiManager = new UIManager();
      this.cityRenderer = new CityRenderer();
      this.cityRenderer.onNeedsRender = () => this.canvasManager.scheduleRender();
      this.nationsManager = new NationsManager(
        this.generator,
        this.canvasManager,
        this.gpuRenderer,
        this.uiManager,
        this.cityRenderer,
      );
      this.nationsManager.onTerritoryChanged = () => (this.thematicFocus = -2);

      console.log("Starting initial generation...");
      this.uiManager.showLoadingModal();
      this.generator
        .generate((pct) => {
          this.uiManager.updateLoadingModal(pct);
        })
        .then(() => {
          this.onWorldGenerated();
          this.uiManager.hideLoadingModal();
        });
    } catch (e) {
      console.error("Failed to initialize GPURenderer:", e);
    }

    this.setupUI();
    this.canvasManager.onRender = this.renderMap.bind(this);

    this.setupEventListeners();
  }

  private onWorldGenerated() {
    const world = this.generator.getWorld();
    this.gpuRenderer.updateWorldTexture(world);
    this.gpuRenderer.updateProvincesDataTexture(world);
    this.nationsManager.nationsStateDirty = true;
    this.nationsManager.hoveredNationIndex = -1;
    this.nationsManager.selectedNationIndex = -1;
    this.nationsManager.buildCache();
    this.cityRenderer.invalidateAll();
    this.vectorState = null;
    this.thematicFocus = -2;
    this.updateLegend();
    this.canvasManager.scheduleRender();
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
      } else if (!this.nationsManager.isEditingNations) {
        this.updateHover(e.clientX, e.clientY);
      } else if (this.activeTab === "nations" && this.nationsManager.isEditingNations) {
        if (isAttemptingPaint && !this.nationsManager.isPainting) {
          const dist = Math.hypot(e.clientX - mousedownX, e.clientY - mousedownY);
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
      const fx = (sx - cm.offsetX) / cm.scale;
      const fy = (sy - cm.offsetY) / cm.scale;
      const wy = Math.floor(fy);
      const x = ((fx % world.width) + world.width) % world.width;

      if (this.nationsManager.nationPlacementMode) {
        if (wy >= 0 && wy < world.height) {
          (async () => {
            await this.nationsManager.addNation(Math.floor(x), wy);
            this.updateTooltipBar();
          })();
        }
      } else if (this.nationsManager.provincePlacementMode !== -1) {
        if (wy >= 0 && wy < world.height) {
          (async () => {
            await this.nationsManager.addProvince(this.nationsManager.provincePlacementMode, x, fy);
            this.updateTooltipBar();
          })();
        }
      } else if (this.nationsManager.cityPlacementMode !== -1) {
        if (wy >= 0 && wy < world.height) {
          (async () => {
            await this.nationsManager.addCity(this.nationsManager.cityPlacementMode, x, fy);
            this.updateTooltipBar();
          })();
        }
      } else if (this.thematic === "diplomacy" && wy >= 0 && wy < world.height) {
        // Click to pin the diplomacy focus
        const cell = world.grid[Math.floor(x)][wy];
        this.nationsManager.selectedNationIndex =
          !cell.isWater && (cell.nationIndex ?? -1) >= 0 ? cell.nationIndex! : -1;
        this.canvasManager.scheduleRender();
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
      if (this.activeTab === "nations" && this.nationsManager.isEditingNations && e.button === 0) {
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
      this.nationsManager.hoveredNationIndex = -1;
      this.tooltipManager.hide();
      this.canvasManager.scheduleRender();
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
    const generateBtn = document.getElementById("generate") as HTMLButtonElement;
    const presetSelect = document.getElementById("preset") as HTMLSelectElement;
    const toggleBtn = document.getElementById("toggle-panel") as HTMLButtonElement;
    const uiPanel = document.getElementById("ui-panel") as HTMLDivElement;

    if (toggleBtn && uiPanel) {
      toggleBtn.addEventListener("click", () => {
        uiPanel.classList.toggle("collapsed");
        toggleBtn.textContent = uiPanel.classList.contains("collapsed") ? "[+]" : "[-]";
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

    // --- Theme & thematic maps ---
    const themeSelect = document.getElementById("theme") as HTMLSelectElement | null;
    themeSelect?.addEventListener("change", () => {
      this.theme = themeSelect.value as MapTheme;
      this.canvasManager.scheduleRender();
    });
    const thematicSelect = document.getElementById("thematic") as HTMLSelectElement | null;
    thematicSelect?.addEventListener("change", () => {
      this.thematic = thematicSelect.value as ThematicMode;
      this.thematicFocus = -2;
      this.updateLegend();
      this.canvasManager.scheduleRender();
    });

    // --- Overlays (Checkboxes) ---
    const overlays = [
      "nations",
      "borders",
      "heatmap",
      "population",
      "moisture",
      "rivers",
      "ice",
      "pois",
      "searoutes",
      "currents",
      "resources",
      "roads",
      "cities",
      "provinces",
      "labels",
    ] as const;
    overlays.forEach((overlay) => {
      const cb = document.getElementById(`layer-${overlay}`) as HTMLInputElement;
      if (cb) {
        cb.addEventListener("change", () => {
          this.activeLayers[overlay] = cb.checked;
          this.canvasManager.scheduleRender();
        });
      }
    });

    const btnEditNations = document.getElementById("btn-edit-nations") as HTMLButtonElement;
    if (btnEditNations) {
      btnEditNations.addEventListener("click", () => {
        this.nationsManager.isEditingNations = !this.nationsManager.isEditingNations;
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
          const cb = document.getElementById("layer-nations") as HTMLInputElement;
          const cbB = document.getElementById("layer-borders") as HTMLInputElement;
          if (cb) cb.checked = true;
          if (cbB) cbB.checked = true;

          this.canvasManager.scheduleRender();
        } else {
          this.canvasManager.panningLocked = false;
          this.canvasManager.canvas.style.cursor = "grab";
        }
      });
    }

    const brushSlider = document.getElementById("brush-size") as HTMLInputElement;
    const brushInput = document.getElementById("brush-size-input") as HTMLInputElement;

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

    // --- Save / open ---
    const saveBtn = document.getElementById("save-world") as HTMLButtonElement | null;
    const openBtn = document.getElementById("open-world") as HTMLButtonElement | null;
    const openInput = document.getElementById("open-world-input") as HTMLInputElement | null;
    saveBtn?.addEventListener("click", async () => {
      const blob = await saveWorld(this.generator);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `world-${this.generator.currentSeed}.world`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    openBtn?.addEventListener("click", () => openInput?.click());
    openInput?.addEventListener("change", async () => {
      const file = openInput.files?.[0];
      openInput.value = "";
      if (!file) return;
      this.uiManager.showLoadingModal();
      try {
        await loadWorld(file, this.generator, (pct) => this.uiManager.updateLoadingModal(pct));
        const W = this.generator.getWidth();
        const H = this.generator.getHeight();
        const fitScale = window.innerHeight / H;
        this.canvasManager.scale = fitScale;
        this.canvasManager.offsetX = (window.innerWidth - W * fitScale) / 2;
        this.canvasManager.offsetY = 0;
        seedInput.value = this.generator.currentSeed.toString();
        presetSelect.value = this.generator.currentPreset;
        const sizeSelect = document.getElementById("size") as HTMLSelectElement | null;
        if (sizeSelect) sizeSelect.value = `${W}x${H}`;
        this.onWorldGenerated();
        this.nationsManager.renderList();
      } catch (err) {
        console.error(err);
        await this.uiManager.confirm("OPEN WORLD", `Could not open this file: ${(err as Error).message}`);
      } finally {
        this.uiManager.hideLoadingModal();
      }
    });

    generateBtn.addEventListener("click", async () => {
      if (generateBtn.classList.contains("loading")) return;

      const p = presetSelect.value as Preset;
      const seedVal = parseInt(seedInput.value) || Math.floor(Math.random() * 999999);
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
        this.onWorldGenerated();
        this.uiManager.hideLoadingModal();
      } finally {
        this.uiManager.setBtnLoading(false, originalText);
      }
    });
  }

  // Rebuilds the thematic overlay texture when the mode or focus changes
  private refreshThematic(world: WorldData) {
    if (this.thematic === "none") return;
    const focus =
      this.thematic === "diplomacy"
        ? this.nationsManager.selectedNationIndex >= 0
          ? this.nationsManager.selectedNationIndex
          : this.nationsManager.hoveredNationIndex
        : -1;
    const key = this.thematic === "diplomacy" ? focus : -1;
    if (this.thematicFocus === key && this.thematicMode === this.thematic) return;
    this.thematicFocus = key;
    this.thematicMode = this.thematic;

    if (this.thematic === "wealth") {
      // Province wealth: its settlements' wealth per unit of land
      const pw = new Float32Array(world.provinces.length);
      for (const c of world.cities) if ((c.provinceIndex ?? -1) >= 0) pw[c.provinceIndex!] += (c.wealth ?? 0) * (1 + c.size);
      const dens = world.provinces.map((p, i) => pw[i] / Math.max(1, (p.area ?? 25) / 25));
      const sorted = [...dens].sort((a, b) => a - b);
      const rank = (v: number) => {
        let lo = 0;
        while (lo < sorted.length && sorted[lo] < v) lo++;
        return lo / Math.max(1, sorted.length - 1);
      };
      const ramp = dens.map((d) => {
        const t = rank(d);
        // earth -> green -> gold
        const r = t < 0.5 ? 120 + t * 80 : 160 + (t - 0.5) * 160;
        const g = t < 0.5 ? 110 + t * 140 : 180 + (t - 0.5) * 40;
        const b = t < 0.5 ? 100 - t * 60 : 70 - (t - 0.5) * 80;
        return [Math.round(r), Math.round(g), Math.round(b), 210] as [number, number, number, number];
      });
      this.gpuRenderer.updateThematicTexture(world, (x, y) => {
        const p = world.grid[x][y].provinceIndex ?? -1;
        return p >= 0 && ramp[p] ? ramp[p] : null;
      });
    } else if (this.thematic === "cultures" || this.thematic === "religions") {
      const list = this.thematic === "cultures" ? world.cultures : world.religions;
      const colors = list.map((c) => hexRgb(c.color));
      const cult = this.thematic === "cultures";
      this.gpuRenderer.updateThematicTexture(world, (x, y) => {
        const cell = world.grid[x][y];
        const id = cult ? cell.cultureIndex : cell.religionIndex;
        if (id === undefined || id < 0 || !colors[id]) return null;
        const c = colors[id];
        return [c[0], c[1], c[2], 200];
      });
    } else {
      const relColors = Object.fromEntries(
        Object.entries(RELATION_COLORS).map(([k, v]) => [k, hexRgb(v)]),
      ) as Record<string, [number, number, number]>;
      const neutral = hexRgb("#b9b4a6");
      this.gpuRenderer.updateThematicTexture(world, (x, y) => {
        const n = world.grid[x][y].nationIndex ?? -1;
        if (n < 0 || n >= world.nations.length) return null;
        if (focus < 0) return [neutral[0], neutral[1], neutral[2], 120];
        if (n === focus) return [230, 190, 60, 255];
        const rel = world.relations[focus]?.[n] ?? "Neutral";
        const c = relColors[rel];
        return [c[0], c[1], c[2], 200];
      });
      this.updateLegend();
    }
  }
  private thematicMode: ThematicMode = "none";

  private updateLegend() {
    const el = document.getElementById("map-legend");
    if (!el) return;
    const world = this.generator.getWorld();
    if (this.thematic === "none") {
      el.style.display = "none";
      return;
    }
    const row = (color: string, text: string) =>
      `<div class="legend-row"><span class="legend-swatch" style="background:${color}"></span><span>${text}</span></div>`;
    let html = "";
    if (this.thematic === "cultures") {
      html = `<div class="legend-title">Cultures</div>` +
        world.cultures
          .map((c) => row(c.color, `${c.name} <span style="opacity:.6">(${world.languages[c.id]?.family.key ?? ""})</span>`))
          .join("");
    } else if (this.thematic === "religions") {
      html = `<div class="legend-title">Religions</div>` + world.religions.map((r) => row(r.color, r.name)).join("");
    } else if (this.thematic === "wealth") {
      html =
        '<div class="legend-title">Provincial wealth</div>' +
        row("rgb(120,110,100)", "Poorest") +
        row("rgb(160,180,70)", "Average") +
        row("rgb(240,200,30)", "Richest") +
        '<div class="legend-hint">From resources, harbours, rivers and trade</div>';
    } else {
      const focus =
        this.nationsManager.selectedNationIndex >= 0
          ? this.nationsManager.selectedNationIndex
          : this.nationsManager.hoveredNationIndex;
      const nation = world.nations[focus];
      html =
        `<div class="legend-title">Diplomacy${nation ? ` · ${nation.name}` : ""}</div>` +
        row("#e6be3c", "Focus nation") +
        Object.entries(RELATION_COLORS)
          .map(([k, v]) => row(v, k))
          .join("") +
        `<div class="legend-hint">${nation ? `${nation.government ?? ""}` : "Hover a nation · click to pin"}</div>`;
    }
    el.innerHTML = html;
    el.style.display = "block";
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

    if (this.nationsManager.nationsStateDirty) {
      this.nationsManager.buildCache();
      this.gpuRenderer.updateNationsDataTexture(world);
      this.nationsManager.nationsStateDirty = false;
      this.thematicFocus = -2;
    }
    this.refreshThematic(world);

    if (this.gpuCanvas.width !== width || this.gpuCanvas.height !== height) {
      this.gpuCanvas.width = width;
      this.gpuCanvas.height = height;
    }

    const hoveredNation =
      this.nationsManager.hoveredNationIndex < world.nations.length ? this.nationsManager.hoveredNationIndex : -1;

    this.gpuRenderer.render(
      width,
      height,
      world.width,
      world.height,
      scale,
      offsetX,
      offsetY,
      this.activeLayers,
      hoveredNation,
      this.nationsManager.hoveredProvinceIndex,
      world.seed,
      this.theme,
      this.thematic,
      hoveredNation >= 0
        ? (hexRgb(world.nations[hoveredNation].color).map((c) => c / 255) as [number, number, number])
        : [1, 1, 1],
      isInteracting,
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const theme = THEMES[this.theme];
    this.drawVectorLayers(ctx, world, width, height, scale, offsetX, offsetY, isInteracting);
    if (this.activeLayers.cities) {
      this.cityRenderer.hoveredNationIndex = this.nationsManager.hoveredNationIndex;
      this.cityRenderer.render(ctx, world, width, height, scale, offsetX, offsetY, this.theme, isInteracting);
    }
    if (this.activeLayers.labels) {
      if (this.activeLayers.rivers) {
        this.networkRenderer.renderRiverLabels(ctx, world, width, height, scale, offsetX, offsetY, theme);
      }
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
        theme,
        this.activeLayers.provinces,
        this.nationsManager.nationLandArea,
      );
    }

    // --- Brush Overlay ---
    if (
      this.nationsManager.isEditingNations &&
      !this.canvasManager.isInteracting &&
      !this.tooltipManager.isVisible
    ) {
      const rect = this.canvasManager.canvas.getBoundingClientRect();
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

  private drawVectorLayers(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    isInteracting: boolean,
  ) {
    const L = this.activeLayers;
    const key = [
      this.theme,
      L.rivers, L.currents, L.searoutes, L.roads, L.resources, L.pois,
      world.seed, world.width, world.worldRoads.length, world.cities.length, width, height,
    ].join("|");
    const st = this.vectorState;
    const ratio = st ? scale / st.scale : 0;
    const same = st && st.key === key;
    const unchanged = same && st!.scale === scale && st!.offX === offsetX && st!.offY === offsetY;
    if (same && (unchanged || (isInteracting && ratio > 0.4 && ratio < 2.5))) {
      ctx.drawImage(this.vectorLayer, offsetX - st!.offX * ratio, offsetY - st!.offY * ratio, width * ratio, height * ratio);
      return;
    }
    if (this.vectorLayer.width !== width || this.vectorLayer.height !== height) {
      this.vectorLayer.width = width;
      this.vectorLayer.height = height;
    }
    const v = this.vectorLayer.getContext("2d")!;
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.clearRect(0, 0, width, height);
    const theme = THEMES[this.theme];
    if (L.rivers) this.networkRenderer.renderRivers(v, world, width, height, scale, offsetX, offsetY, theme);
    if (L.currents) this.networkRenderer.renderCurrents(v, world, width, height, scale, offsetX, offsetY);
    if (L.searoutes) this.networkRenderer.renderSeaRoutes(v, world, width, height, scale, offsetX, offsetY, theme);
    if (L.roads) this.networkRenderer.renderRoads(v, world, width, height, scale, offsetX, offsetY, theme);
    if (L.resources) this.networkRenderer.renderResources(v, world, width, height, scale, offsetX, offsetY, theme);
    if (L.pois) this.poiRenderer.render(v, world, width, height, scale, offsetX, offsetY, this.theme);
    ctx.drawImage(this.vectorLayer, 0, 0);
    this.vectorState = { scale, offX: offsetX, offY: offsetY, key };
  }

  private lastMouseX: number | undefined;
  private lastMouseY: number | undefined;

  private updateMapRuler(scale: number) {
    // 1 cell = 5 km; work in meters so the ruler keeps working at street level
    const mPerPixel = 5000 / scale;
    const targetM = 300 * mPerPixel;
    const magnitude = Math.pow(10, Math.floor(Math.log10(targetM)));
    const normalized = targetM / magnitude;
    const niceMultiplier = normalized < 2 ? 1 : normalized < 5 ? 2 : 5;
    const niceM = niceMultiplier * magnitude;
    const actualViewPixels = niceM / mPerPixel;

    const rulerEl = document.getElementById("map-ruler");
    if (rulerEl) {
      rulerEl.style.display = "flex";
      const rulerLine = rulerEl.querySelector(".ruler-line") as HTMLElement;
      const rulerTextEnd = rulerEl.querySelector("#ruler-text-end") as HTMLElement;
      const rulerTextMid = rulerEl.querySelector("#ruler-text-mid") as HTMLElement;
      if (rulerLine && rulerTextEnd && rulerTextMid) {
        rulerLine.style.width = `${actualViewPixels}px`;
        const format = (m: number, unit: boolean) => {
          if (m >= 1000) {
            const km = m / 1000;
            const txt = km >= 1000 ? `${(km / 1000).toFixed(km % 1000 === 0 ? 0 : 1)}k` : `${+km.toFixed(1)}`;
            return unit ? `${txt} km` : txt;
          }
          return unit ? `${+m.toFixed(1)} m` : `${+m.toFixed(1)}`;
        };
        rulerTextMid.textContent = format(niceM / 2, false);
        rulerTextEnd.textContent = format(niceM, true);
      }
    }
  }

  private updateTooltipBar() {
    const overlay = document.getElementById("tooltip-bar");
    if (!overlay) return;

    if (this.nationsManager.nationPlacementMode) {
      overlay.textContent = "CREATING NEW NATION... (CLICK ON MAP)";
      overlay.style.display = "block";
    } else if (this.nationsManager.provincePlacementMode !== -1) {
      overlay.textContent = "PLACING PROVINCE SEAT... (CLICK INSIDE THE NATION)";
      overlay.style.display = "block";
    } else if (this.nationsManager.cityPlacementMode !== -1) {
      const nation = this.generator.getWorld().nations[this.nationsManager.cityPlacementMode];
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
    const fx = (sx - cm.offsetX) / cm.scale;
    const fy = (sy - cm.offsetY) / cm.scale;
    const wy = Math.floor(fy);
    const x = ((Math.floor(fx) % world.width) + world.width) % world.width;
    let newHovered = -1;
    let cell = null;
    const onLand = wy >= 0 && wy < world.height && !world.sampler.isWater(fx, fy);
    if (wy >= 0 && wy < world.height) {
      cell = world.grid[x][wy];
      if (onLand && cell.nationIndex !== undefined && cell.nationIndex >= 0) newHovered = cell.nationIndex;
    }

    if (newHovered !== this.nationsManager.hoveredNationIndex) {
      this.nationsManager.hoveredNationIndex = newHovered;
      if (this.thematic === "diplomacy" && this.nationsManager.selectedNationIndex < 0) this.updateLegend();
      this.canvasManager.scheduleRender();

      document.querySelectorAll(".nation-item").forEach((el) => el.classList.remove("hovered"));
      if (newHovered !== -1) {
        const item = document.querySelector(`.nation-item[data-index="${newHovered}"]`);
        item?.classList.add("hovered");
      }
    }

    if (!cell) {
      this.tooltipManager.hide();
      return;
    }

    // Nearby city takes priority
    let nearestCity = null;
    let nearestDist = Infinity;
    for (const city of world.cities) {
      let dx = Math.abs(fx - city.x);
      if (dx > world.width / 2) dx = world.width - dx;
      const dist = Math.hypot(dx, fy - city.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestCity = city;
      }
    }
    const nation = newHovered >= 0 ? world.nations[newHovered] : null;
    const lines: string[] = [];
    if (this.activeLayers.resources && cm.scale > 2.8) {
      let best = null;
      let bd = 8 / cm.scale;
      for (const r of world.resources) {
        let dx = Math.abs(r.x - fx);
        if (dx > world.width / 2) dx = world.width - dx;
        const d = Math.hypot(dx, r.y - fy);
        if (d < bd) {
          bd = d;
          best = r;
        }
      }
      if (best) {
        const info = RESOURCE_INFO[best.kind];
        const grade = best.richness > 1.2 ? "Rich" : best.richness > 0.85 ? "Good" : "Modest";
        this.tooltipManager.show(clientX, clientY, info.label, grade + " deposit · trade value " + info.value + "/12");
        return;
      }
    }
    if (this.activeLayers.pois && cm.scale > 2.6) {
      const poi = nearestPoi(world, fx, fy, 9 / cm.scale);
      if (poi) {
        const owner = world.nations[poi.nationIndex];
        this.tooltipManager.show(clientX, clientY, poi.name, `${POI_LABELS[poi.kind]}${owner ? ` · ${owner.name}` : ""}`);
        return;
      }
    }
    if (nearestCity && nearestDist < Math.max(10 / cm.scale, (nearestCity.radiusM / 5000) * 1.1)) {
      const owner = world.nations[nearestCity.nationIndex];
      const kind = nearestCity.isCapital ? "♦ Capital" : nearestCity.size === 2 ? "● City" : nearestCity.size === 1 ? "● Town" : "· Village";
      lines.push(`${kind}${owner ? ` of ${owner.name}` : ""}`);
      lines.push(`Population ${nearestCity.population.toLocaleString()}`);
      lines.push(`Area ~${(Math.PI * (nearestCity.radiusM / 1000) ** 2).toFixed(1)} km²${nearestCity.isPort ? " · Port" : ""}`);
      lines.push("Wealth: " + WEALTH_TIERS[nearestCity.wealthTier ?? 2]);
      if (nearestCity.resources?.length)
        lines.push(
          "Trades in " +
            nearestCity.resources.map((k) => RESOURCE_INFO[k as keyof typeof RESOURCE_INFO]?.label.toLowerCase()).join(", "),
        );
      const prov = world.provinces[nearestCity.provinceIndex ?? -1];
      if (prov) lines.push(`Province: ${prov.name}`);
      this.tooltipManager.show(clientX, clientY, nearestCity.name, lines.join("\n"));
      return;
    }

    if (!onLand) {
      const owner = world.nations[cell.nationIndex ?? -1];
      const lake = world.waterType[wy * world.width + x] === 2;
      lines.push(owner ? `${lake ? "Internal waters" : "Territorial waters"} of ${owner.name}` : "International waters");
      lines.push(`Depth ~${Math.abs(WorldData.elevationMeters(Math.min(cell.elevation, 0.449))).toLocaleString()} m`);
      this.tooltipManager.show(clientX, clientY, lake ? "Lake" : cell.elevation < 0.3 ? "Open Ocean" : "Sea", lines.join("\n"));
      return;
    }

    if (nation) {
      lines.push(`${nation.government ?? "Realm"} of ${nation.name}`);
      const prov = world.provinces[cell.provinceIndex ?? -1];
      if (prov) lines.push(`Province: ${prov.name}${prov.area ? ` (${prov.area.toLocaleString()} km²)` : ""}`);
      if (this.thematic === "diplomacy") {
        const focus = this.nationsManager.selectedNationIndex;
        if (focus >= 0 && focus !== newHovered) {
          lines.push(`Relation with ${world.nations[focus]?.name}: ${world.relations[focus]?.[newHovered] ?? "Neutral"}`);
        }
      }
    }
    const culture = world.cultures[cell.cultureIndex ?? -1];
    const religion = world.religions[cell.religionIndex ?? -1];
    if (culture) lines.push(`Culture: ${culture.name}`);
    if (religion) lines.push(`Faith: ${religion.name}`);
    lines.push(`${cell.biome} · ${WorldData.elevationMeters(cell.elevation).toLocaleString()} m · ${WorldData.temperatureC(cell.temperature)}°C`);
    lines.push(`Density ~${peoplePerKm2(cell.populationDensity)} /km²${cell.hasRiver ? " · River" : ""}`);
    this.tooltipManager.show(clientX, clientY, nation ? nation.name : "Unclaimed Land", lines.join("\n"));
  }

  private renderMapIndicators() {
    document.querySelectorAll(".map-loading-indicator").forEach((el) => el.remove());

    const world = this.generator.getWorld();
    const cm = this.canvasManager;

    this.nationsManager.pendingCityIds.forEach((cityId) => {
      const city = world.cities[cityId];
      if (!city) return;

      const sx = city.x * cm.scale + cm.offsetX;
      const sy = city.y * cm.scale + cm.offsetY;

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
