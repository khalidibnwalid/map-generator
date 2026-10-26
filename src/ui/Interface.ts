import { CELL_KM2 } from "../game/WorldData";
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
import { installSteppers } from "./components/NumberInput";
import { saveWorld, loadWorld } from "../game/WorldFile";
import { RESOURCE_INFO, WEALTH_TIERS } from "../game/generators/generateEconomy";
import { cityExports, cityTrade, tradeRole } from "../game/generators/generateTrade";
import { THEMES, NIGHT_THEMES } from "./themes";
import { MONTHS, seasonFlood } from "../core/Season";
import { refreshPickers } from "./components/MainApp";
import { WorldData } from "../game/WorldData";
import { RELATION_COLORS } from "../game/generators/generateDiplomacy";
import { blocOf } from "../game/politics";
import { nationFlagUrl } from "../game/flags";
import { installSliders, syncSliders } from "./components/Slider";
import { Simulation, type SimEvent } from "../game/sim/Simulation";
import { viewStats, type SnapNation } from "../game/sim/History";
import { crownRulers, rulerStyle, seededRand } from "../game/sim/Rulers";
import { BuildTool } from "./BuildTool";
import { createDropdown } from "./components/Dropdown";
import { dimOutside, layoutContext, yieldToUI, type AtlasHost, type MapView } from "./AtlasRender";
import { PosterDialog } from "./PosterDialog";
import { ImportDialog, paintGuide } from "./ImportDialog";
import { FactSheet } from "./FactSheet";
import { drawBattles, drawFronts } from "./WarRenderer";
import { exportHistoryGif } from "./GifExport";
import type { Nation } from "../game/WorldData";

// A recorded year shown in place of the live borders (History timeline)
interface Replay {
  index: number;
  year: number;
  owner: Int16Array; // index into nations
  nations: SnapNation[];
  world: WorldData; // the live world with these nations, for labels and textures
  sizes: number[];
  centroids: { x: number; y: number }[];
  land: number[];
}

// Chronicle filter groups
const EVENT_GROUP: Record<SimEvent["kind"], string> = {
  war: "war",
  peace: "war",
  battle: "war",
  conquest: "war",
  civil: "realm",
  vassal: "realm",
  independence: "realm",
  fall: "realm",
  annex: "realm",
  growth: "realm",
  decline: "realm",
  ruin: "realm",
  founding: "realm",
  ruler: "ruler",
};

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
    trade: false,
    currents: false,
    resources: true,
    labels: true,
    flags: true,
    cities: true,
    season: false,
    night: false,
    weather: false,
    wars: true,
  };
  private seasonMonth = new Date().getMonth(); // 0 = January, fractional between months
  private lightsKey = ""; // world state the night-lights texture was built for
  private weatherTimer = 0;
  private weatherStart = performance.now();
  // Soft warm disc, drawn additively over detailed cities at night
  private glowSprite: HTMLCanvasElement | null = null;
  private replay: Replay | null = null;
  private simFilter = "all";
  private exportingGif = false;
  private activeTab: "generate" | "layers" | "nations" | "build" | "history" | "file" = "generate";
  private buildTool!: BuildTool;
  private sim: Simulation | null = null;
  private simTimer = 0;
  private simSpeed = 2;
  private simListAt = 0; // last nations-list refresh while history runs
  private inSimStep = false;
  private interactive = false; // map clicks advance the simulation
  private jumping = false; // a multi-year skip is running
  // Command a battle: chosen realms (kept as objects, indices shift) and aim mode
  private warAttacker: Nation | null = null;
  private pointerDown = { x: 0, y: 0 }; // a click after a drag is a pan, not an attack
  private warPicking = false; // next map click chooses the army's realm
  private theme: MapTheme = "Realistic";
  private thematic: ThematicMode = "none";
  private thematicFocus = -2; // nation the diplomacy texture was built for
  private exporting = false; // a poster or fact-sheet map is being rendered
  private renderChain: Promise<void> = Promise.resolve();
  private posterDialog: PosterDialog | null = null;
  private importDialog: ImportDialog | null = null;
  private guideName = "";
  private factSheet: FactSheet | null = null;

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
      this.buildTool = new BuildTool(this.generator, this.nationsManager);
      this.buildTool.onChanged = () => {
        const sel = this.buildTool.selected;
        if (sel?.type === "city") this.cityRenderer.invalidateCity(sel.city);
        this.vectorState = null;
        this.lightsKey = "";
        this.sim?.markEdited();
        if (this.activeTab === "nations") this.nationsManager.renderList();
        this.canvasManager.scheduleRender();
      };
      this.nationsManager.onShowFacts = (idx) => this.showFacts(idx);
      this.nationsManager.onTerritoryChanged = () => {
        this.thematicFocus = -2;
        if (!this.inSimStep) this.sim?.markEdited();
      };

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

  private showFacts(idx: number) {
    if (this.generator.isGenerating || !this.generator.getWorld().nations[idx]) return;
    this.factSheet ??= new FactSheet(this.atlasHost());
    this.factSheet.open(idx);
  }

  private onWorldGenerated() {
    this.pauseSim();
    this.warAttacker = null;
    this.warPicking = false;
    this.renderWarRoom();
    if (this.buildTool) {
      this.buildTool.selected = null;
      this.buildTool.render();
    }
    this.sim = null;
    this.replay = null;
    const world = this.generator.getWorld();
    // Houses and rulers from a seeded stream of their own, so generation is unaffected
    crownRulers(world, seededRand(world.seed * 7919 + world.nations.length));
    if (world.savedSim) {
      // A loaded file brings its recorded history along
      this.sim = new Simulation(world, this.generator.getNoise());
      this.sim.restore(world.savedSim);
      world.savedSim = undefined;
    }
    this.renderSimPanel();
    this.gpuRenderer.updateWorldTexture(world);
    this.gpuRenderer.updateProvincesDataTexture(world);
    this.nationsManager.nationsStateDirty = true;
    this.nationsManager.hoveredNationIndex = -1;
    this.nationsManager.selectedNationIndex = -1;
    this.nationsManager.buildCache();
    this.cityRenderer.invalidateAll();
    this.vectorState = null;
    this.lightsKey = "";
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
        this.nationsManager.nationPlacementMode ||
        (this.activeTab === "build" && this.buildTool.tool) ||
        (this.activeTab === "history" && (this.warAttacker || this.warPicking))
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

      // Alt+click a realm for its fact sheet
      if (e.altKey && wy >= 0 && wy < world.height && !world.sampler.isWater(fx, fy)) {
        const n = world.grid[Math.floor(x)][wy].nationIndex ?? -1;
        if (n >= 0) {
          this.tooltipManager.hide();
          this.showFacts(n);
          return;
        }
      }

      const dragged = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y) > 5;
      if (this.activeTab === "history" && this.warPicking && !dragged && wy >= 0 && wy < world.height) {
        // Pick mode: the clicked realm becomes the army
        const cell = world.grid[Math.floor(x)][wy];
        const owner = cell.isWater ? -1 : (cell.nationIndex ?? -1);
        if (owner >= 0) {
          this.warPicking = false;
          this.warAttacker = world.nations[owner];
          this.setWarHint(`Commanding ${this.warAttacker.name}. Click enemy land to attack.`);
          this.renderWarRoom();
        }
      } else if (this.activeTab === "history" && this.warAttacker && !dragged && wy >= 0 && wy < world.height) {
        // Any other realm's land is a target; the army's own land does nothing
        const cell = world.grid[Math.floor(x)][wy];
        const owner = cell.isWater ? -1 : (cell.nationIndex ?? -1);
        const att = world.nations.indexOf(this.warAttacker);
        if (owner >= 0 && owner !== att) this.launchBattle(owner, { x, y: fy });
      } else if (this.interactive && this.activeTab === "history" && !dragged) {
        this.pauseSim();
        this.stepSim();
      } else if (this.activeTab === "build" && wy >= 0 && wy < world.height) {
        if (this.buildTool.tool) this.buildTool.place(x, fy);
        else {
          this.buildTool.selected = this.buildTool.pick(x, fy, cm.scale);
          this.buildTool.render();
        }
        this.canvasManager.scheduleRender();
      } else if (this.nationsManager.nationPlacementMode) {
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
      this.pointerDown = { x: e.clientX, y: e.clientY };
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

    // Right-click removes the object under the cursor while building
    canvas.addEventListener("contextmenu", (e) => {
      if (this.activeTab !== "build") return;
      e.preventDefault();
      const cm = this.canvasManager;
      const rect = cm.canvas.getBoundingClientRect();
      const world = this.generator.getWorld();
      const fx = (e.clientX - rect.left - cm.offsetX) / cm.scale;
      const fy = (e.clientY - rect.top - cm.offsetY) / cm.scale;
      const x = ((fx % world.width) + world.width) % world.width;
      this.buildTool.remove(this.buildTool.pick(x, fy, cm.scale));
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.buildTool?.tool) {
        this.buildTool.setTool(null);
        this.canvasManager.canvas.style.cursor = "grab";
      }
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

    // The app never scrolls as a whole: focusing an off-screen control would
    // otherwise shift the map up and leave a blank band below it
    const app = document.getElementById("app");
    window.addEventListener(
      "scroll",
      () => {
        if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
        if (app && (app.scrollTop || app.scrollLeft)) {
          app.scrollTop = 0;
          app.scrollLeft = 0;
        }
      },
      true,
    );

    if (toggleBtn && uiPanel) {
      toggleBtn.addEventListener("click", () => uiPanel.classList.add("collapsed"));
    }

    // --- Rail tabs: one panel at a time; clicking the open one closes it ---
    const tabs = ["generate", "layers", "nations", "build", "history", "file"] as const;
    const titles = { generate: "World", layers: "Layers", nations: "Nations", build: "Build", history: "History", file: "File" };
    tabs.forEach((tab) => {
      const btn = document.getElementById(`tab-${tab}`);
      const content = document.getElementById(`content-${tab}`);
      if (btn && content) {
        btn.addEventListener("click", () => {
          const collapsed = uiPanel?.classList.contains("collapsed");
          if (this.activeTab === tab && !collapsed) {
            uiPanel?.classList.add("collapsed");
            btn.classList.remove("active");
            return;
          }
          uiPanel?.classList.remove("collapsed");
          this.activeTab = tab;
          tabs.forEach((t) => {
            document.getElementById(`tab-${t}`)?.classList.remove("active");
            document.getElementById(`content-${t}`)?.classList.remove("active");
          });
          btn.classList.add("active");
          content.classList.add("active");
          const title = document.getElementById("panel-title");
          if (title) title.textContent = titles[tab];
          if (tab === "nations") this.nationsManager.renderList();
          if (tab === "build") this.buildTool.render();
          if (tab === "history") {
            this.renderWarRoom();
            this.renderSimPanel();
          }
          else if (this.buildTool.tool || this.buildTool.selected) {
            this.buildTool.tool = null;
            this.buildTool.selected = null;
            this.canvasManager.scheduleRender();
          }
        });
      }
    });

    // --- History simulation ---
    document.getElementById("sim-play")?.addEventListener("click", () => this.toggleSim());
    document.getElementById("sim-bar-play")?.addEventListener("click", () => this.toggleSim());
    document.getElementById("war-pick")?.addEventListener("click", () => {
      this.warPicking = !this.warPicking;
      if (this.warPicking) this.setWarHint("Click a realm on the map to command its army.");
      this.renderWarRoom();
    });
    document.getElementById("war-clear")?.addEventListener("click", () => {
      if (!this.sim) return;
      this.sim.clearWarMarks();
      this.setWarHint("Battle marks and conquest borders cleared. Conquered land stays with its new owner.");
      this.canvasManager.scheduleRender();
    });
    document.getElementById("sim-step")?.addEventListener("click", () => {
      this.pauseSim();
      this.stepSim();
    });
    installSteppers(document.getElementById("content-history") ?? document);
    for (const [id, simulate] of [["sim-jump", true], ["sim-skip", false]] as const) {
      document.getElementById(id)?.addEventListener("click", () => {
        const input = document.getElementById("sim-jump-years") as HTMLInputElement | null;
        this.pauseSim();
        void this.jumpYears(Math.max(1, Math.min(1000, Math.floor(Number(input?.value)) || 1)), simulate);
      });
    }
    document.getElementById("sim-interactive")?.addEventListener("change", (e) => {
      this.interactive = (e.target as HTMLInputElement).checked;
      this.pauseSim();
      this.renderSimPanel();
    });
    const speedSelect = document.getElementById("sim-speed") as HTMLSelectElement | null;
    speedSelect?.addEventListener("change", () => {
      this.simSpeed = Number(speedSelect.value) || 2;
      if (this.simTimer) {
        this.pauseSim();
        this.playSim();
      }
    });
    document.getElementById("sim-log")?.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".sim-event");
      if (!row) return;
      this.centerOn(Number(row.dataset.x), Number(row.dataset.y));
    });
    const filterSelect = document.getElementById("sim-filter") as HTMLSelectElement | null;
    filterSelect?.addEventListener("change", () => {
      this.simFilter = filterSelect.value;
      this.renderSimPanel();
    });
    // The panel timeline and the one on the bar over the map do the same thing
    for (const id of ["sim-scrub", "sim-bar-scrub"]) {
      const scrub = document.getElementById(id) as HTMLInputElement | null;
      scrub?.addEventListener("input", () => {
        if (!this.sim) return;
        this.pauseSim();
        const f = Number(scrub.value);
        if (f >= this.sim.history.length - 1) this.backToPresent();
        else this.showReplay(f);
      });
    }
    document.getElementById("sim-present")?.addEventListener("click", () => this.backToPresent());
    document.getElementById("sim-gif")?.addEventListener("click", () => this.exportGif());

    // --- Map controls ---
    const zoomBy = (factor: number) => {
      const cm = this.canvasManager;
      const cx = cm.getWidth() / 2;
      const cy = cm.getHeight() / 2;
      cm.offsetX = cx - (cx - cm.offsetX) * factor;
      cm.offsetY = cy - (cy - cm.offsetY) * factor;
      cm.scale *= factor;
      cm.scheduleRender();
    };
    document.getElementById("zoom-in")?.addEventListener("click", () => zoomBy(1.6));
    document.getElementById("zoom-out")?.addEventListener("click", () => zoomBy(1 / 1.6));
    document.getElementById("zoom-reset")?.addEventListener("click", () => {
      const W = this.generator.getWidth();
      const H = this.generator.getHeight();
      const fit = window.innerHeight / H;
      this.canvasManager.scale = fit;
      this.canvasManager.offsetX = (window.innerWidth - W * fit) / 2;
      this.canvasManager.offsetY = 0;
      this.canvasManager.scheduleRender();
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
      "trade",
      "currents",
      "resources",
      "roads",
      "cities",
      "provinces",
      "labels",
      "flags",
      "season",
      "night",
      "weather",
      "wars",
    ] as const;
    const seasonRow = document.getElementById("season-row");
    overlays.forEach((overlay) => {
      const cb = document.getElementById(`layer-${overlay}`) as HTMLInputElement;
      if (cb) {
        cb.addEventListener("change", () => {
          this.activeLayers[overlay] = cb.checked;
          if (overlay === "season") seasonRow?.classList.toggle("off", !cb.checked);
          if (overlay === "weather") this.setWeatherTimer(cb.checked);
          this.canvasManager.scheduleRender();
        });
      }
    });

    // --- Seasons: month slider (moving it turns seasons on) ---
    const monthSlider = document.getElementById("season-month") as HTMLInputElement | null;
    const monthLabel = document.getElementById("season-month-label");
    const seasonCb = document.getElementById("layer-season") as HTMLInputElement | null;
    if (monthSlider) {
      const showMonth = () => {
        if (monthLabel) monthLabel.textContent = MONTHS[Math.round(this.seasonMonth) % 12];
      };
      monthSlider.value = String(this.seasonMonth);
      syncSliders(seasonRow ?? document);
      showMonth();
      seasonRow?.classList.toggle("off", !this.activeLayers.season);
      monthSlider.addEventListener("input", () => {
        this.seasonMonth = Number(monthSlider.value) || 0;
        showMonth();
        if (!this.activeLayers.season && seasonCb) {
          seasonCb.checked = true;
          this.activeLayers.season = true;
          seasonRow?.classList.remove("off");
        }
        this.canvasManager.scheduleRender();
      });
    }

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
        syncSliders(brushSlider.parentElement ?? document);
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
    installSliders();

    // --- Save / open ---
    const saveBtn = document.getElementById("save-world") as HTMLButtonElement | null;
    const openBtn = document.getElementById("open-world") as HTMLButtonElement | null;
    const openInput = document.getElementById("open-world-input") as HTMLInputElement | null;
    saveBtn?.addEventListener("click", async () => {
      const blob = await saveWorld(this.generator, this.sim?.save());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `world-${this.generator.currentSeed}.world`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    openBtn?.addEventListener("click", () => openInput?.click());
    document.getElementById("export-poster")?.addEventListener("click", () => {
      if (this.generator.isGenerating) return; // textures and statistics are not ready
      this.posterDialog ??= new PosterDialog(this.atlasHost());
      this.posterDialog.open(this.nationsManager.selectedNationIndex);
    });
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
    installSliders();
        presetSelect.value = this.generator.currentPreset;
        const sizeSelect = document.getElementById("size") as HTMLSelectElement | null;
        if (sizeSelect) sizeSelect.value = `${W}x${H}`;
        const powersSelect = document.getElementById("great-powers") as HTMLSelectElement | null;
        if (powersSelect) powersSelect.value = String(this.generator.greatPowers);
        refreshPickers();
        this.guideName = file.name.replace(/\.world$/i, "");
        this.syncGuideCard();
        this.onWorldGenerated();
        this.nationsManager.renderList();
      } catch (err) {
        console.error(err);
        await this.uiManager.confirm("OPEN WORLD", `Could not open this file: ${(err as Error).message}`);
      } finally {
        this.uiManager.hideLoadingModal();
      }
    });

    // --- Shape from an image ---
    const openImport = (file?: File) => {
      if (this.generator.isGenerating) return;
      const sizeSelect = document.getElementById("size") as HTMLSelectElement | null;
      const [w, h] = (sizeSelect?.value ?? "800x450").split("x").map(Number);
      if (!this.importDialog) {
        this.importDialog = new ImportDialog();
        this.importDialog.onApply = (guide, name) => {
          this.generator.guide = guide;
          this.guideName = name;
          this.syncGuideCard();
          generateBtn.click();
        };
      }
      // Preview with the seed the next world will be generated from
      this.importDialog.open(w, h, parseInt(seedInput.value) || this.generator.currentSeed, file);
    };
    document.getElementById("guide-import")?.addEventListener("click", () => openImport());
    document.getElementById("guide-edit")?.addEventListener("click", () => openImport());
    const clearGuide = () => {
      this.generator.guide = null;
      this.syncGuideCard();
    };
    document.getElementById("guide-clear")?.addEventListener("click", clearGuide);
    presetSelect.addEventListener("change", clearGuide);
    // Dropping a picture anywhere on the app opens the import
    window.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      openImport(file);
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
      const powersSelect = document.getElementById("great-powers") as HTMLSelectElement | null;
      if (powersSelect) this.generator.greatPowers = Number(powersSelect.value) || 0;

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

  // World tab: the imported picture in use, which overrides the presets
  private syncGuideCard() {
    const guide = this.generator.guide;
    const card = document.getElementById("guide-card");
    const importBtn = document.getElementById("guide-import");
    if (!card || !importBtn) return;
    card.style.display = guide ? "" : "none";
    importBtn.style.display = guide ? "none" : "";
    document.querySelector('.picker[data-for="preset"]')?.classList.toggle("overridden", !!guide);
    if (!guide) return;
    document.getElementById("guide-name")!.textContent = this.guideName || "Imported image";
    void paintGuide(document.getElementById("guide-thumb") as HTMLCanvasElement, guide);
  }

  private toggleSim() {
    if (this.simTimer) this.pauseSim();
    else this.playSim();
  }

  private playSim() {
    if (this.simTimer || this.generator.isGenerating || this.exportingGif) return;
    // Replays are view-only: history always continues from the present
    this.backToPresent();
    // Chained timeouts: a slow year delays the next instead of piling up
    const tick = () => {
      const t0 = performance.now();
      this.stepSim();
      if (!this.simTimer) return;
      this.simTimer = window.setTimeout(tick, Math.max(16, 1000 / this.simSpeed - (performance.now() - t0)));
    };
    this.simTimer = window.setTimeout(tick, 0);
    this.renderSimPanel();
  }

  private pauseSim() {
    if (!this.simTimer) return;
    clearTimeout(this.simTimer);
    this.simTimer = 0;
    this.renderSimPanel();
  }

  private stepSim() {
    if (this.generator.isGenerating || this.exportingGif) return;
    this.backToPresent();
    const world = this.generator.getWorld();
    this.sim ??= new Simulation(world, this.generator.getNoise());
    const nationsBefore = world.nations.length;
    const citiesBefore = world.cities.length;
    const colorsBefore = world.nations.map((n) => n.color).join();
    this.inSimStep = true;
    const changed = this.sim.step();
    this.applySimChanges(changed, nationsBefore, citiesBefore, colorsBefore);
    this.inSimStep = false;
    this.renderSimPanel();
  }

  // Runs `years` years back to back, yielding to the browser between slices
  private async jumpYears(years: number, simulate = true) {
    if (this.jumping || this.generator.isGenerating || this.exportingGif) return;
    this.jumping = true;
    this.backToPresent();
    const world = this.generator.getWorld();
    this.sim ??= new Simulation(world, this.generator.getNoise());
    const nationsBefore = world.nations.length;
    const citiesBefore = world.cities.length;
    const colorsBefore = world.nations.map((n) => n.color).join();
    const btn = document.getElementById(simulate ? "sim-jump" : "sim-skip") as HTMLButtonElement | null;
    const label = btn?.querySelector("span");
    const idle = label?.textContent ?? "";
    for (const id of ["sim-jump", "sim-skip"]) (document.getElementById(id) as HTMLButtonElement | null)?.setAttribute("disabled", "");
    let changed = false;
    try {
      for (let done = 0; done < years; ) {
        const t0 = performance.now();
        this.inSimStep = true;
        while (done < years && performance.now() - t0 < 40) {
          if (simulate) changed = this.sim.step() || changed;
          else this.sim.skipYear();
          done++;
        }
        this.inSimStep = false;
        if (label) label.textContent = `${done}/${years}`;
        // A world regenerated meanwhile ends the run
        if (this.generator.getWorld() !== world) return;
        await new Promise((r) => setTimeout(r));
      }
      this.inSimStep = true;
      this.applySimChanges(changed, nationsBefore, citiesBefore, colorsBefore);
      this.inSimStep = false;
    } finally {
      this.inSimStep = false;
      this.jumping = false;
      for (const id of ["sim-jump", "sim-skip"]) document.getElementById(id)?.removeAttribute("disabled");
      if (label) label.textContent = idle;
      this.renderSimPanel();
    }
  }

  // Uploads and caches after the simulation changed the world (a year or a
  // commanded battle)
  private applySimChanges(changed: boolean, nationsBefore: number, citiesBefore: number, colorsBefore: string) {
    const world = this.generator.getWorld();
    if (!this.sim) return;
    if (changed) {
      if (this.nationsManager.hoveredNationIndex >= world.nations.length) this.nationsManager.hoveredNationIndex = -1;
      if (world.nations.length !== nationsBefore) this.nationsManager.selectedNationIndex = -1;
      // Upload only the rows that changed (colors change for every row when nations come or go)
      const d = this.sim.dirty;
      if (d.provinces) this.gpuRenderer.updateProvincesDataTexture(world);
      const owner = this.sim.ownerArray;
      if (world.nations.map((n) => n.color).join() !== colorsBefore) this.gpuRenderer.updateNationsDataTexture(world, undefined, owner);
      else if (d.y1 >= d.y0)
        this.gpuRenderer.updateNationsDataTexture(world, { x: 0, y: d.y0, w: world.width, h: d.y1 - d.y0 + 1 }, owner);
      this.sim.dirty = { y0: Infinity, y1: -1, provinces: false };
      this.nationsManager.buildCache(owner);
      this.sim.changedCities.clear();
      this.thematicFocus = -2;
      const now = performance.now();
      if (this.activeTab === "nations" && (!this.simTimer || now - this.simListAt > 1500)) {
        this.simListAt = now;
        this.nationsManager.renderList();
      }
    }
    // Settlements grew, shrank, fell to ruin or were founded; trade was re-routed
    const ec = this.sim.econ;
    if (ec.touched.size || ec.removed.length || ec.tradeChanged || world.cities.length !== citiesBefore) {
      for (const c of ec.touched) this.cityRenderer.invalidateCity(c);
      for (const c of ec.removed) this.cityRenderer.invalidateCity(c);
      const sel = this.buildTool.selected;
      if (sel?.type === "city" && ec.removed.includes(sel.city)) this.buildTool.selected = null;
      this.vectorState = null;
      // Wealth only moves when trade is re-routed or settlements come and go
      if (ec.tradeChanged || world.cities.length !== citiesBefore || ec.removed.length) this.thematicFocus = -2;
      ec.clearDirty();
      this.canvasManager.scheduleRender();
    }
    // Offensive arrows and battle markers change every year
    if (changed || this.activeLayers.wars) this.canvasManager.scheduleRender();
  }

  // --- Command a battle ---
  private renderWarRoom() {
    const world = this.generator.getWorld();
    const host = (id: string) => document.getElementById(id);
    const attHost = host("war-attacker");
    if (!attHost) return;
    if (this.warAttacker && !world.nations.includes(this.warAttacker)) this.warAttacker = null;
    const att = this.warAttacker ? world.nations.indexOf(this.warAttacker) : -1;
    const byName = world.nations.map((n, i) => ({ n, i })).sort((a, b) => a.n.name.localeCompare(b.n.name));
    const opt = (i: number) => ({ value: String(i), label: world.nations[i].name, image: nationFlagUrl(world, i, 18, 12) });
    attHost.replaceChildren(
      createDropdown({
        className: "war-dd",
        value: String(att),
        options: [{ value: "-1", label: "Choose a realm" }, ...byName.map((e) => opt(e.i))],
        onChange: (v) => {
          this.warPicking = false;
          this.warAttacker = world.nations[Number(v)] ?? null;
          this.setWarHint(
            this.warAttacker ? `Commanding ${this.warAttacker.name}. Click enemy land to attack.` : "Pick an army, then click enemy land to attack. It always wins.",
          );
          this.renderWarRoom();
        },
      }),
    );
    document.getElementById("war-pick")?.classList.toggle("active", this.warPicking);
    const history = this.activeTab === "history";
    this.canvasManager.canvas.style.cursor = history && this.warPicking ? "pointer" : history && this.warAttacker ? "crosshair" : "grab";
  }

  private setWarHint(text: string) {
    const el = document.getElementById("war-hint");
    if (el) el.textContent = text;
  }

  // The chosen army wins outright against `defender`, aiming at a point or the capital
  private launchBattle(defender: number, aim?: { x: number; y: number }) {
    if (this.generator.isGenerating || this.exportingGif) return;
    const world = this.generator.getWorld();
    const attacker = this.warAttacker ? world.nations.indexOf(this.warAttacker) : -1;
    if (attacker < 0 || defender < 0 || attacker === defender) return;
    this.pauseSim();
    this.backToPresent();
    this.sim ??= new Simulation(world, this.generator.getNoise());
    const nationsBefore = world.nations.length;
    const citiesBefore = world.cities.length;
    const colorsBefore = world.nations.map((n) => n.color).join();
    const A = world.nations[attacker];
    const D = world.nations[defender];
    const force = Number((document.getElementById("war-force") as HTMLSelectElement | null)?.value) || 2;
    this.inSimStep = true;
    const res = this.sim.commandBattle(attacker, defender, force, aim);
    this.applySimChanges(!!res, nationsBefore, citiesBefore, colorsBefore);
    this.inSimStep = false;
    const fallen = !world.nations.includes(D);
    this.setWarHint(
      res
        ? `${A.name} wins at ${res.place} and takes ${Math.round(res.taken * CELL_KM2).toLocaleString()} km² from ${D.name}.${fallen ? ` ${D.name} has fallen.` : ""}`
        : `${A.name} found no way to strike ${D.name} there.`,
    );
    this.renderSimPanel();
    this.renderWarRoom();
    if (this.activeTab === "nations") this.nationsManager.renderList();
  }

  // Shows recorded year `f` in place of the live borders
  private showReplay(f: number) {
    const sim = this.sim;
    const view = sim?.history.view(f);
    if (!sim || !view) return;
    const world = this.generator.getWorld();
    const byUid = new Map(view.nations.map((s, i) => [s.uid, i]));
    const nations: Nation[] = view.nations.map((s, i) => ({
      id: i,
      name: s.name,
      color: s.color,
      capitalX: s.capitalX,
      capitalY: s.capitalY,
      cultureId: s.cultureId,
      flag: s.flag,
      overlord: s.overlord >= 0 ? byUid.get(s.overlord) : undefined,
    }));
    // The live world seen through this year's nations; provinces are not recorded
    const past = Object.create(world) as WorldData;
    past.nations = nations;
    past.provinces = [];
    const owner = view.owner.slice(); // the recorder reuses its buffer
    this.gpuRenderer.updateNationsDataTexture(past, undefined, owner);
    const st = viewStats({ ...view, owner }, world.width, world.height, world.waterType);
    this.replay = {
      index: f,
      year: view.year,
      owner,
      nations: view.nations,
      world: past,
      sizes: st.sizes,
      centroids: st.centroids,
      land: st.land,
    };
    this.nationsManager.hoveredNationIndex = -1;
    this.tooltipManager.hide();
    this.renderSimPanel();
    this.canvasManager.scheduleRender();
  }

  private backToPresent() {
    if (!this.replay) return;
    this.replay = null;
    // From the grid: the sim's owner array may lag behind edits made while paused
    this.gpuRenderer.updateNationsDataTexture(this.generator.getWorld());
    this.renderSimPanel();
    this.canvasManager.scheduleRender();
  }

  private async exportGif() {
    const sim = this.sim;
    if (!sim || this.exportingGif || sim.history.length < 2) return;
    this.pauseSim();
    this.exportingGif = true;
    const btn = document.getElementById("sim-gif") as HTMLButtonElement | null;
    const label = btn?.querySelector(".sim-gif-label");
    const progress = (p: number) => {
      const pct = `${Math.round(p * 100)}%`;
      btn?.style.setProperty("--progress", pct);
      if (label) label.textContent = `Encoding frames… ${pct}`;
    };
    this.renderSimPanel();
    progress(0);
    try {
      const world = this.generator.getWorld();
      const blob = await exportHistoryGif(world, sim.history, sim.battles, progress);
      const first = sim.history.frames[0].year;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `history-${this.generator.currentSeed}-years-${first}-${sim.year}.gif`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error(err);
      await this.uiManager.confirm("EXPORT GIF", `Could not export the animation: ${(err as Error).message}`);
    } finally {
      this.exportingGif = false;
      btn?.style.removeProperty("--progress");
      if (label) label.textContent = "Export GIF";
      this.renderSimPanel();
    }
  }

  private centerOn(x: number, y: number) {
    if (!isFinite(x) || !isFinite(y)) return;
    const cm = this.canvasManager;
    cm.offsetX = cm.getWidth() / 2 - x * cm.scale;
    cm.offsetY = cm.getHeight() / 2 - y * cm.scale;
    cm.scheduleRender();
  }

  private renderSimPanel() {
    const playing = !!this.simTimer;
    const play = document.getElementById("sim-play");
    if (play) {
      play.innerHTML = playing
        ? `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor"/></svg><span>Pause</span>`
        : `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg><span>${this.sim ? "Resume" : "Play"}</span>`;
    }
    if (play) (play as HTMLButtonElement).disabled = this.interactive;
    const barPlay = document.getElementById("sim-bar-play");
    if (barPlay) (barPlay as HTMLButtonElement).disabled = this.interactive;
    if (barPlay) {
      barPlay.innerHTML = playing
        ? `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor"/></svg>`
        : `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>`;
    }
    const bar = document.getElementById("sim-bar");
    if (bar) bar.style.display = this.sim ? "flex" : "none";
    const sim = this.sim;
    const world = this.generator.getWorld();
    const replay = this.replay;
    bar?.classList.toggle("replay", !!replay);
    const year = document.getElementById("sim-bar-year");
    if (year) year.textContent = String(replay ? replay.year : (sim?.year ?? 0));
    const last = document.getElementById("sim-bar-event");
    if (last)
      last.textContent = replay
        ? `Replay · borders of year ${replay.year} (present: ${sim?.year ?? 0})`
        : sim?.events[0]
          ? `${sim.events[0].year} · ${sim.events[0].text}`
          : "";

    // --- Timeline ---
    const frames = sim?.history.length ?? 0;
    const scrub = document.getElementById("sim-scrub") as HTMLInputElement | null;
    if (scrub) {
      scrub.max = String(Math.max(0, frames - 1));
      scrub.value = String(replay ? replay.index : Math.max(0, frames - 1));
      scrub.disabled = frames < 2 || this.exportingGif;
      syncSliders(scrub.parentElement ?? document);
    }
    const barScrub = document.getElementById("sim-bar-scrub") as HTMLInputElement | null;
    if (barScrub) {
      barScrub.max = String(Math.max(0, frames - 1));
      barScrub.value = String(replay ? replay.index : Math.max(0, frames - 1));
      barScrub.disabled = frames < 2 || this.exportingGif;
    }
    const firstYear = sim && frames ? sim.history.frames[0].year : null;
    const setText = (id: string, t: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = t;
    };
    setText("sim-scrub-from", firstYear !== null ? `Year ${firstYear}` : "–");
    setText("sim-scrub-to", sim && frames ? `Year ${sim.year}` : "–");
    setText("sim-scrub-year", replay ? `Year ${replay.year} · replay` : sim ? `Year ${sim.year}` : "");
    const present = document.getElementById("sim-present") as HTMLButtonElement | null;
    if (present) present.disabled = !replay;
    const gif = document.getElementById("sim-gif") as HTMLButtonElement | null;
    if (gif) {
      gif.disabled = frames < 2 || this.exportingGif;
      gif.title = frames < 2 ? "Simulate a few years first" : `${frames} recorded years`;
    }

    const summary = document.getElementById("sim-summary");
    if (summary) {
      let wars = 0;
      let vassals = 0;
      world.nations.forEach((n, i) => {
        if (n.overlord !== undefined) vassals++;
        for (let j = i + 1; j < world.nations.length; j++) if (world.relations[i]?.[j] === "War") wars++;
      });
      const stat = (v: number | string, label: string) => `<div class="sim-stat"><strong>${v}</strong><small>${label}</small></div>`;
      summary.innerHTML = stat(sim?.year ?? 0, "Year") + stat(world.nations.length, "Nations") + stat(wars, "Wars") ;
      summary.title = `${vassals} vassal state${vassals === 1 ? "" : "s"}`;
    }
    const log = document.getElementById("sim-log");
    if (log && sim) {
      const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
      const shown = this.simFilter === "all" ? sim.events : sim.events.filter((e) => EVENT_GROUP[e.kind] === this.simFilter);
      log.innerHTML = shown.length
        ? shown
            .slice(0, 120)
            .map((e) => `<div class="sim-event ${e.kind}" data-x="${e.x}" data-y="${e.y}"><span class="yr">${e.year}</span><span class="txt">${esc(e.text)}</span></div>`)
            .join("")
        : `<p class="muted">${sim.events.length ? "Nothing of this kind yet." : "A quiet year."}</p>`;
    } else if (log) log.innerHTML = '<p class="muted">Nothing has happened yet.</p>';
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
    } else if (this.thematic === "cultures") {
      const list = world.cultures;
      const colors = list.map((c) => hexRgb(c.color));
      this.gpuRenderer.updateThematicTexture(world, (x, y) => {
        const cell = world.grid[x][y];
        const id = cell.cultureIndex;
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
    } else if (this.thematic === "wealth") {
      html =
        '<div class="legend-title">Provincial wealth</div>' +
        row("rgb(120,110,100)", "Poorest") +
        row("rgb(160,180,70)", "Average") +
        row("rgb(240,200,30)", "Richest") +
        '<div class="legend-hint">From resources, harbors, rivers and trade</div>';
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
      // An edit while replaying returns to the present (the texture below is the live one)
      if (this.replay) {
        this.replay = null;
        this.renderSimPanel();
      }
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

    const replay = this.replay;
    const night = this.activeLayers.night;
    if (night) this.refreshLights(world);
    this.renderTerrain(width, height, scale, offsetX, offsetY, isInteracting);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const theme = night ? NIGHT_THEMES[this.theme] : THEMES[this.theme];
    this.drawVectorLayers(ctx, world, width, height, scale, offsetX, offsetY, isInteracting);
    // An export shares the city cache; live frames would evict its plans
    if (this.activeLayers.cities && !this.exporting) {
      this.cityRenderer.hoveredNationIndex = this.nationsManager.hoveredNationIndex;
      this.cityRenderer.render(ctx, world, width, height, scale, offsetX, offsetY, this.theme, isInteracting);
    }
    if (night) this.drawNightOverlay(ctx, world, width, height, scale, offsetX, offsetY);
    const sim = this.sim;
    if (this.activeLayers.wars && sim) {
      // Recently won land is outlined in offensive mode (the History panel)
      const gains = !replay && this.activeTab === "history" ? sim.recentGains() : [];
      if (!replay) drawFronts(ctx, gains, sim.offensives, world.width, width, scale, offsetX, offsetY);
      drawBattles(ctx, sim.battles, replay ? replay.year : sim.year, world.width, width, height, scale, offsetX, offsetY);
    }
    if (this.activeLayers.labels) {
      if (this.activeLayers.rivers) {
        this.networkRenderer.renderRiverLabels(ctx, world, width, height, scale, offsetX, offsetY, theme);
      }
      this.labelRenderer.render(
        ctx,
        replay ? replay.world : world,
        width,
        height,
        scale,
        offsetX,
        offsetY,
        isInteracting,
        replay ? replay.sizes : this.nationsManager.nationSizes,
        replay ? replay.centroids : this.nationsManager.nationCentroids,
        theme,
        this.activeLayers.provinces && !replay,
        replay ? replay.land : this.nationsManager.nationLandArea,
        this.activeLayers.flags,
      );
    }

    if (this.activeTab === "build") this.buildTool.drawOverlay(ctx, scale, offsetX, offsetY, width);

    // --- City hovered in the nations list ---
    const hc = this.nationsManager.hoveredCityId >= 0 ? world.cities.find((c) => c.id === this.nationsManager.hoveredCityId) : undefined;
    if (hc) {
      const r = Math.max(9, Math.min(26, scale * 0.6));
      ctx.save();
      for (let copy = -1; copy <= 1; copy++) {
        const sx = (hc.x + copy * world.width) * scale + offsetX;
        const sy = hc.y * scale + offsetY;
        if (sx < -50 || sx > width + 50 || sy < -50 || sy > height + 50) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(212, 168, 90, 0.22)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#d4a85a";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff4dc";
        ctx.fill();
        ctx.font = "600 12px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = "rgba(20, 16, 11, 0.85)";
        ctx.strokeText(hc.name, sx, sy - r - 9);
        ctx.fillStyle = "#fff4dc";
        ctx.fillText(hc.name, sx, sy - r - 9);
      }
      ctx.restore();
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
        ctx.strokeStyle = "rgba(212, 168, 90, 0.9)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(sx, sy, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(212, 168, 90, 0.9)";
        ctx.fill();
        ctx.restore();
      }
    }

    this.updateMapRuler(scale);
    this.renderMapIndicators();
  }

  // GPU terrain for the live view (also used to restore it after export tiles)
  private renderTerrain(width: number, height: number, scale: number, offsetX: number, offsetY: number, isInteracting: boolean) {
    const world = this.generator.getWorld();
    const replay = this.replay;
    const hoveredNation =
      !replay && this.nationsManager.hoveredNationIndex < world.nations.length ? this.nationsManager.hoveredNationIndex : -1;
    this.gpuRenderer.hoverBloc = hoveredNation >= 0 ? blocOf(world, hoveredNation) : [];
    this.gpuRenderer.season = this.seasonMonth / 12;
    this.gpuRenderer.time = (performance.now() - this.weatherStart) / 1000;
    this.gpuRenderer.render(
      width,
      height,
      world.width,
      world.height,
      scale,
      offsetX,
      offsetY,
      // Provinces are not recorded, so a replay shows nation borders only
      replay ? { ...this.activeLayers, provinces: false } : this.activeLayers,
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
  }

  // Clouds drift at ~12 fps by redrawing only the WebGL terrain; the overlay
  // canvas above it is left alone. Runs only while Weather is on.
  private setWeatherTimer(on: boolean) {
    if (on && !this.weatherTimer) {
      this.weatherTimer = window.setInterval(() => {
        const cm = this.canvasManager;
        if (document.hidden || cm.isInteracting || this.generator.isGenerating) return;
        const w = this.gpuCanvas.width;
        const h = this.gpuCanvas.height;
        if (!w || !h) return;
        this.renderTerrain(w, h, cm.scale, cm.offsetX, cm.offsetY, false);
      }, 80);
    } else if (!on && this.weatherTimer) {
      clearInterval(this.weatherTimer);
      this.weatherTimer = 0;
    }
  }

  // Rebuilds the night-lights texture when cities or roads changed
  private refreshLights(world: WorldData) {
    const key = `${world.seed}|${world.width}|${world.cities.length}|${world.worldRoads.length}`;
    if (key === this.lightsKey) return;
    this.lightsKey = key;
    this.gpuRenderer.updateLightsTexture(world);
  }

  // Night over the canvas layers drawn so far (rivers, roads, cities): dim
  // them toward the moonlit palette, then light detailed cities from within.
  private drawNightOverlay(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
  ) {
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = "rgba(8, 12, 30, 0.58)";
    ctx.fillRect(0, 0, width, height);
    if (this.activeLayers.cities) {
      if (!this.glowSprite) {
        const s = (this.glowSprite = document.createElement("canvas"));
        s.width = s.height = 128;
        const g = s.getContext("2d")!;
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, "rgba(255, 196, 120, 0.5)");
        grad.addColorStop(0.5, "rgba(255, 160, 80, 0.22)");
        grad.addColorStop(1, "rgba(255, 140, 60, 0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
      }
      ctx.globalCompositeOperation = "lighter";
      const mapW = world.width * scale;
      for (const c of world.cities) {
        const r = (c.radiusM / 5000) * scale * 1.7;
        if (r < 8) continue;
        const sy = c.y * scale + offsetY;
        if (sy < -r || sy > height + r) continue;
        // First copy of the wrapped world that could be on screen
        let sx = c.x * scale + offsetX;
        sx -= Math.ceil((sx + r) / mapW) * mapW - mapW;
        for (; sx - r < width; sx += mapW) {
          ctx.globalAlpha = Math.min(1, (r - 8) / 12);
          ctx.drawImage(this.glowSprite, sx - r, sy - r, r * 2, r * 2);
        }
      }
    }
    ctx.restore();
  }

  // Renders the map (current theme, thematic mode and layers) into a
  // rectangle of any 2D context at any resolution. The terrain is drawn in
  // tiles through the live WebGL canvas, each copied out immediately (its
  // buffer is not preserved) and the live frame restored before yielding.
  public async renderMapTo(ctx: CanvasRenderingContext2D, v: MapView) {
    const world = this.generator.getWorld();
    const L = this.activeLayers;
    const pr = v.pixelRatio;
    const lw = v.w / pr;
    const lh = v.h / pr;
    const ls = v.scale / pr;
    const lox = v.offsetX / pr;
    const loy = v.offsetY / pr;
    if (this.nationsManager.nationsStateDirty) {
      this.nationsManager.buildCache();
      this.gpuRenderer.updateNationsDataTexture(world);
      this.nationsManager.nationsStateDirty = false;
      this.thematicFocus = -2;
    }
    this.refreshThematic(world);
    this.exporting = true;
    try {
      // City plans build in the background: wait (bounded) for those in view
      if (L.cities && v.waitForCities) {
        const scratch = document.createElement("canvas").getContext("2d")!;
        const t0 = performance.now();
        for (;;) {
          this.cityRenderer.render(scratch, world, lw, lh, ls, lox, loy, this.theme, false, true);
          if (!this.cityRenderer.busy || performance.now() - t0 > 20000 || v.canceled?.()) break;
          v.onProgress?.(0, "Laying out towns and cities");
          await new Promise((r) => setTimeout(r, 120));
        }
      }

      const gpu = this.gpuRenderer;
      const lim = gpu.tileLimit;
      const tw = Math.max(16, Math.min(lim.w, 2048));
      const th = Math.max(16, Math.min(lim.h, 2048));
      const tiles: { x: number; y: number; w: number; h: number }[] = [];
      for (let y = 0; y < v.h; y += th)
        for (let x = 0; x < v.w; x += tw) tiles.push({ x, y, w: Math.min(tw, v.w - x), h: Math.min(th, v.h - y) });

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(v.x, v.y, v.w, v.h);
      ctx.clip();
      const cm = this.canvasManager;
      for (let i = 0; i < tiles.length; i++) {
        if (v.canceled?.()) break;
        const t = tiles[i];
        gpu.pixelRatio = pr;
        gpu.frame = { x: t.x, y: t.y, w: v.w, h: v.h };
        gpu.hoverBloc = [];
        gpu.render(t.w, t.h, world.width, world.height, v.scale, v.offsetX - t.x, v.offsetY - t.y, L, -1, -1, world.seed, this.theme, this.thematic, [1, 1, 1], false);
        ctx.drawImage(this.gpuCanvas, 0, lim.bufferH - t.h, t.w, t.h, v.x + t.x, v.y + t.y, t.w, t.h);
        gpu.pixelRatio = 1;
        gpu.frame = null;
        this.renderTerrain(cm.getWidth(), cm.getHeight(), cm.scale, cm.offsetX, cm.offsetY, false);
        v.onProgress?.(((i + 1) / tiles.length) * 0.75, "Rendering terrain");
        if (tiles.length > 1) await yieldToUI();
      }

      if (!v.canceled?.()) {
        v.onProgress?.(0.8, "Drawing rivers, roads and cities");
        await yieldToUI();
        const night = !!L.night;
        const theme = night ? NIGHT_THEMES[this.theme] : THEMES[this.theme];
        // At night the drawn layers are dimmed on their own canvas (like the
        // live overlay), so the terrain underneath isn't darkened twice
        const layer = night ? document.createElement("canvas") : null;
        if (layer) {
          layer.width = v.w;
          layer.height = v.h;
        }
        const lctx = layer ? layer.getContext("2d")! : ctx;
        let restore = layoutContext(lctx, pr, layer ? 0 : v.x, layer ? 0 : v.y);
        if (L.rivers) {
          const H = world.height;
          const month = this.seasonMonth;
          const swell = L.season ? (y: number) => 1 + 0.35 * seasonFlood(month, (y / H) * 2 - 1) : undefined;
          this.networkRenderer.renderRivers(lctx, world, lw, lh, ls, lox, loy, theme, swell);
        }
        if (L.currents) this.networkRenderer.renderCurrents(lctx, world, lw, lh, ls, lox, loy);
        if (L.searoutes) this.networkRenderer.renderSeaRoutes(lctx, world, lw, lh, ls, lox, loy, theme);
        if (L.roads) this.networkRenderer.renderRoads(lctx, world, lw, lh, ls, lox, loy, theme);
        if (L.trade) this.networkRenderer.renderTrade(lctx, world, lw, lh, ls, lox, loy);
        if (L.resources) this.networkRenderer.renderResources(lctx, world, lw, lh, ls, lox, loy, theme);
        if (L.pois) this.poiRenderer.render(lctx, world, lw, lh, ls, lox, loy, this.theme);
        if (L.cities) {
          const hovered = this.cityRenderer.hoveredNationIndex;
          this.cityRenderer.hoveredNationIndex = -1;
          this.cityRenderer.render(lctx, world, lw, lh, ls, lox, loy, this.theme, false, true);
          this.cityRenderer.hoveredNationIndex = hovered;
        }
        if (layer) {
          this.drawNightOverlay(lctx, world, lw, lh, ls, lox, loy);
          restore();
          ctx.drawImage(layer, v.x, v.y);
          restore = layoutContext(ctx, pr, v.x, v.y);
        }
        if (L.labels) {
          if (L.rivers) this.networkRenderer.renderRiverLabels(ctx, world, lw, lh, ls, lox, loy, theme);
          this.labelRenderer.render(
            ctx, world, lw, lh, ls, lox, loy, false,
            this.nationsManager.nationSizes,
            this.nationsManager.nationCentroids,
            theme,
            L.provinces,
            this.nationsManager.nationLandArea,
            L.flags,
          );
        }
        restore();
        if (v.keep) dimOutside(ctx, world, v, v.keep, this.theme);
      }
      ctx.restore();
    } finally {
      this.gpuRenderer.pixelRatio = 1;
      this.gpuRenderer.frame = null;
      this.exporting = false;
      this.canvasManager.scheduleRender();
    }
  }

  // The narrow view of the app the poster and fact sheet work with
  private atlasHost(): AtlasHost {
    return {
      getWorld: () => this.generator.getWorld(),
      mapTheme: () => this.theme,
      thematicMode: () => this.thematic,
      simYear: () => this.sim?.year ?? 0,
      simEvents: () => this.sim?.events ?? [],
      landArea: () => this.nationsManager.nationLandArea,
      // One at a time: renders share the WebGL canvas and the city cache
      renderMapTo: (ctx, view) => {
        const run = this.renderChain.then(() => this.renderMapTo(ctx, view));
        this.renderChain = run.catch(() => undefined);
        return run;
      },
    };
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
      L.rivers, L.currents, L.searoutes, L.roads, L.trade, L.resources, L.pois,
      L.season ? this.seasonMonth.toFixed(2) : "-",
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
    if (L.rivers) {
      // Rivers run a little fuller in spring melt and the tropical wet season
      const month = this.seasonMonth;
      const H = world.height;
      const swell = L.season ? (y: number) => 1 + 0.35 * seasonFlood(month, (y / H) * 2 - 1) : undefined;
      this.networkRenderer.renderRivers(v, world, width, height, scale, offsetX, offsetY, theme, swell);
    }
    if (L.currents) this.networkRenderer.renderCurrents(v, world, width, height, scale, offsetX, offsetY);
    if (L.searoutes) this.networkRenderer.renderSeaRoutes(v, world, width, height, scale, offsetX, offsetY, theme);
    if (L.roads) this.networkRenderer.renderRoads(v, world, width, height, scale, offsetX, offsetY, theme);
    if (L.trade) this.networkRenderer.renderTrade(v, world, width, height, scale, offsetX, offsetY);
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
    // Replay: name the realm that held this ground in the shown year
    const replay = this.replay;
    if (replay) {
      this.nationsManager.hoveredNationIndex = -1;
      const k = wy >= 0 && wy < world.height && !world.sampler.isWater(fx, fy) ? replay.owner[wy * world.width + x] : -1;
      const s = replay.nations[k];
      if (!s) {
        this.tooltipManager.hide();
        return;
      }
      const over = replay.nations.find((o) => o.uid === s.overlord);
      const lines = [`In the year ${replay.year}`];
      if (s.ruler) lines.push(`Ruled by ${s.ruler}`);
      if (over) lines.push(`Vassal of ${over.name}`);
      this.tooltipManager.show(clientX, clientY, s.name, lines.join("\n"), nationFlagUrl(replay.world, k, 24, 16));
      return;
    }
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
      // e.g. "Trade hub · 3 caravan routes · 1 sea lane", then exports
      const trade = cityTrade(nearestCity);
      const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
      const tradeBits = [tradeRole(trade, !!nearestCity.isPort)];
      if (trade?.caravans) tradeBits.push(plural(trade.caravans, "caravan route"));
      if (trade?.lanes) tradeBits.push(plural(trade.lanes, "sea lane"));
      lines.push(tradeBits.join(" · "));
      if (trade?.cut) lines.push(`War has cut ${plural(trade.cut, "trade route")}`);
      const exports = cityExports(nearestCity);
      if (exports.length) lines.push((trade && trade.volume > 0 ? "Exports " : "Produces ") + exports.join(", "));
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
      const r = nation.ruler;
      if (r) {
        const reign = world.year - r.since;
        lines.push(`${rulerStyle(nation)}${nation.dynasty ? ` · House of ${nation.dynasty}` : ""}`);
        lines.push(`Age ${world.year - r.born} · ${reign < 1 ? "newly crowned" : `${reign} year${reign === 1 ? "" : "s"} on the throne`}`);
      }
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
    if (culture) lines.push(`Culture: ${culture.name}`);
    lines.push(`${cell.biome} · ${WorldData.elevationMeters(cell.elevation).toLocaleString()} m · ${WorldData.temperatureC(cell.temperature)}°C`);
    lines.push(`Density ~${peoplePerKm2(cell.populationDensity)} /km²${cell.hasRiver ? " · River" : ""}`);
    if (nation) lines.push("Alt+click for the fact sheet");
    this.tooltipManager.show(
      clientX,
      clientY,
      nation ? nation.name : "Unclaimed Land",
      lines.join("\n"),
      nation ? nationFlagUrl(world, newHovered, 24, 16) : "",
    );
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
