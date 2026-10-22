import type { MapGenerator } from "../game/MapGenerator";
import type { CanvasManager } from "../core/CanvasManager";
import type { GPURenderer } from "../core/GPURenderer";
import { connectCity, partitionNation, finalizeCity, cityNameFor, colorForNewNation } from "../game/generators";
import type { City, Nation } from "../game/WorldData";
import { CELL_KM2 } from "../game/WorldData";
import type { UIManager } from "./UIManager";
import type { CityRenderer } from "./CityRenderer";

type SortKey = "name" | "area" | "population" | "cities" | "wealth";
interface NationStats {
  population: number;
  cities: number;
  wealth: number;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "area", label: "Area" },
  { key: "population", label: "Pop." },
  { key: "cities", label: "Cities" },
  { key: "wealth", label: "Wealth" },
];

function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return Math.round(n).toString();
}

export class NationsManager {
  public hoveredNationIndex: number = -1;
  public hoveredProvinceIndex: number = -1;
  public selectedNationIndex: number = -1;
  public selectedProvinceIndex: number = -1;
  public isEditingNations: boolean = false;
  public isPainting: boolean = false;
  public brushSize: number = 2;
  public nationCellsList: Set<number>[] = [];
  public nationCentroids: { x: number; y: number }[] = [];
  public nationSizes: number[] = [];
  public nationLandArea: number[] = []; // land cells only; water is never counted
  public onTerritoryChanged: (() => void) | null = null;
  public nationsStateDirty: boolean = true;
  public cityPlacementMode: number = -1; // Index of the nation being founded for
  public provincePlacementMode: number = -1; // Index of the nation for new province
  public nationPlacementMode: boolean = false;
  public pendingCityIds: Set<number> = new Set();
  private expandedNations: Set<number> = new Set();
  private expandedProvinces: Set<number> = new Set();
  private sortKey: SortKey = "area";
  private sortDesc = true;
  private stats: NationStats[] = [];
  private nationSubTabs: Map<number, "cities" | "provinces"> = new Map();
  private cityMap: Map<number, City> = new Map();

  private lastPaintedX: number | null = null;
  private lastPaintedY: number | null = null;

  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private gpuRenderer: GPURenderer;
  private uiManager: UIManager;
  private cityRenderer: CityRenderer;

  constructor(
    generator: MapGenerator,
    canvasManager: CanvasManager,
    gpuRenderer: GPURenderer,
    uiManager: UIManager,
    cityRenderer: CityRenderer,
  ) {
    this.generator = generator;
    this.canvasManager = canvasManager;
    this.gpuRenderer = gpuRenderer;
    this.uiManager = uiManager;
    this.cityRenderer = cityRenderer;
  }

  // Frames a city so its whole plan fits on screen
  private focusCity(city: City) {
    const cm = this.canvasManager;
    const radiusCells = (city.radiusM * 1.6) / 5000;
    const fit = (Math.min(cm.getWidth(), cm.getHeight()) * 0.45) / Math.max(radiusCells, 1e-3);
    cm.lookAt(city.x, city.y, Math.max(cm.scale, Math.min(fit, 20000)));
  }

  public renderList() {
    // Commit any half-typed name before the inputs are rebuilt; skipping the
    // render instead left the list stale after renames, paints and new nations.
    const active = document.activeElement as HTMLInputElement | null;
    if (active && active.tagName === "INPUT" && active.closest("#nations-list")) {
      active.dispatchEvent(new Event("change"));
      active.blur();
    }

    const listContainer = document.getElementById("nations-list");
    if (!listContainer) return;

    const world = this.generator.getWorld();
    listContainer.innerHTML = "";

    const addNationBtn = document.createElement("button");
    addNationBtn.className = `nation-add-btn ${this.nationPlacementMode ? "active" : ""}`;
    addNationBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
      </svg>
      <span>${this.nationPlacementMode ? "CANCEL CREATION" : "NEW NATION"}</span>
    `;
    addNationBtn.addEventListener("click", () => {
      this.nationPlacementMode = !this.nationPlacementMode;
      this.cityPlacementMode = -1;
      this.renderList();
      this.canvasManager.scheduleRender();
    });
    listContainer.appendChild(addNationBtn);

    // --- Sorting ---
    this.stats = world.nations.map(() => ({ population: 0, cities: 0, wealth: 0 }));
    for (const c of world.cities) {
      const st = this.stats[c.nationIndex];
      if (!st) continue;
      st.population += c.population;
      st.cities++;
      st.wealth += c.wealth ?? 0;
    }
    const sortBar = document.createElement("div");
    sortBar.className = "nation-sort";
    for (const { key, label } of SORTS) {
      const b = document.createElement("button");
      b.className = `nation-sort-btn ${this.sortKey === key ? "active" : ""}`;
      b.textContent = label;
      b.title = `Sort by ${label.toLowerCase()}`;
      b.addEventListener("click", () => {
        if (this.sortKey === key) this.sortDesc = !this.sortDesc;
        else {
          this.sortKey = key;
          this.sortDesc = key !== "name";
        }
        this.renderList();
      });
      sortBar.appendChild(b);
    }
    const dir = document.createElement("button");
    dir.className = "nation-sort-dir";
    dir.title = this.sortDesc ? "Descending" : "Ascending";
    dir.textContent = this.sortDesc ? "↓" : "↑";
    dir.addEventListener("click", () => {
      this.sortDesc = !this.sortDesc;
      this.renderList();
    });
    sortBar.appendChild(dir);
    listContainer.appendChild(sortBar);

    const order = world.nations.map((_, i) => i);
    const value = (i: number): number | string => {
      switch (this.sortKey) {
        case "name":
          return world.nations[i].name.toLowerCase();
        case "area":
          return this.nationLandArea[i] || 0;
        case "population":
          return this.stats[i].population;
        case "cities":
          return this.stats[i].cities;
        case "wealth":
          return this.stats[i].wealth;
      }
    };
    order.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return this.sortDesc ? -c : c;
    });

    order.forEach((idx) => {
      const nation = world.nations[idx];
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
      territoryCount.textContent = this.metricText(idx);

      const deleteNationBtn = document.createElement("button");
      deleteNationBtn.className = "nation-delete-btn";
      deleteNationBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4Z M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
        </svg>
      `;
      deleteNationBtn.title = "Delete Nation";
      deleteNationBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await this.uiManager.confirm(
          "DISSOLVE NATION",
          `Are you sure you want to dissolve ${nation.name}? Its territory will be cleared, but its cities will remain independent.`,
        );
        if (confirmed) {
          this.deleteNation(idx);
        }
      });

      item.appendChild(toggleBtn);
      item.appendChild(swatchContainer);
      item.appendChild(nameInput);
      item.appendChild(territoryCount);
      item.appendChild(deleteNationBtn);

      item.addEventListener("click", () => {
        this.selectedNationIndex = idx;
        this.selectedProvinceIndex = -1; // Reset province selection when nation is clicked
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

      // Render sub-tabs and list if expanded
      if (this.expandedNations.has(idx)) {
        const subTabs = document.createElement("div");
        subTabs.className = "nation-sub-tabs";

        const currentTab = this.nationSubTabs.get(idx) || "cities";

        const citiesTab = document.createElement("button");
        citiesTab.className = `nation-sub-tab-btn ${currentTab === "cities" ? "active" : ""}`;
        citiesTab.textContent = "CITIES";
        citiesTab.addEventListener("click", (e) => {
          e.stopPropagation();
          this.nationSubTabs.set(idx, "cities");
          this.renderList();
        });

        const provincesTab = document.createElement("button");
        provincesTab.className = `nation-sub-tab-btn ${currentTab === "provinces" ? "active" : ""}`;
        provincesTab.textContent = "PROVINCES";
        provincesTab.addEventListener("click", (e) => {
          e.stopPropagation();
          this.nationSubTabs.set(idx, "provinces");
          this.renderList();
        });

        subTabs.appendChild(citiesTab);
        subTabs.appendChild(provincesTab);
        listContainer.appendChild(subTabs);

        const contentContainer = document.createElement("div");
        contentContainer.id = `nation-content-${idx}`;
        listContainer.appendChild(contentContainer);

        if (currentTab === "cities") {
          this.renderCityList(idx, -1, contentContainer);
        } else {
          this.renderProvinceList(idx, contentContainer);
        }
      }
    });

    // Add "Unaffiliated" section if there are orphan cities
    const orphanCities = world.cities.filter((c) => c.nationIndex === -1);
    if (orphanCities.length > 0) {
      const idx = -1;
      const item = document.createElement("div");
      item.className = `nation-item unaffiliated ${this.selectedNationIndex === idx ? "selected" : ""}`;

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

      const swatch = document.createElement("div");
      swatch.className = "nation-color-swatch-container";
      swatch.innerHTML = `<div class="nation-color-swatch" style="background: #666; box-shadow: 0 0 5px #666;"></div>`;

      const nameLabel = document.createElement("span");
      nameLabel.className = "nation-name-label";
      nameLabel.textContent = "UNAFFILIATED";
      nameLabel.style.color = "var(--text-dim)";
      nameLabel.style.flex = "1";

      const cityCount = document.createElement("span");
      cityCount.className = "nation-territory-count";
      cityCount.textContent = `${orphanCities.length} cities`;

      item.appendChild(toggleBtn);
      item.appendChild(swatch);
      item.appendChild(nameLabel);
      item.appendChild(cityCount);

      item.addEventListener("click", () => {
        this.selectedNationIndex = idx;
        this.renderList();
      });

      const cityListContainer = document.createElement("div");
      cityListContainer.id = `city-list-${idx}`;

      listContainer.appendChild(item);
      listContainer.appendChild(cityListContainer);

      if (this.expandedNations.has(idx)) {
        this.renderCityList(-1, -1, cityListContainer); // unaffiliated nation, no province
      }
    }
  }

  private renderProvinceList(nationIdx: number, container: HTMLElement) {
    const world = this.generator.getWorld();
    container.innerHTML = "";
    container.className = "province-sub-list";

    const nationProvinces = world.provinces.filter(
      (p) => p.nationIndex === nationIdx,
    );

    // Add "Direct Rule" option if editing
    if (this.isEditingNations) {
      const directItem = document.createElement("div");
      directItem.className = `province-item ${this.selectedProvinceIndex === -1 ? "selected" : ""}`;
      directItem.style.paddingLeft = "24px";
      directItem.innerHTML = `
        <div class="province-header">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="opacity:0.5; margin-right:4px;">
              <path d="M19,3H5C3.89,3 3,3.89 3,5V19C3,20.11 3.89,21 5,21H19C20.11,21 21,20.11 21,19V5C21,3.89 20.11,3 19,3M19,19H5V5H19V19Z"/>
           </svg>
           <span style="font-size: 10px; font-weight: bold; opacity: 0.7; letter-spacing: 0.05em;">DIRECT RULE</span>
        </div>
      `;
      directItem.addEventListener("click", () => {
        this.selectedProvinceIndex = -1;
        this.renderList();
      });
      container.appendChild(directItem);
    }

    nationProvinces.forEach((province) => {
      const pIdx = province.id;
      const item = document.createElement("div");
      item.className = `province-item ${this.selectedProvinceIndex === pIdx ? "selected" : ""}`;

      const toggleBtn = document.createElement("button");
      toggleBtn.className = `nation-toggle-btn ${this.expandedProvinces.has(pIdx) ? "expanded" : ""}`;
      toggleBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M8.59,16.59L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.59Z"/>
        </svg>
      `;
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.expandedProvinces.has(pIdx)) {
          this.expandedProvinces.delete(pIdx);
        } else {
          this.expandedProvinces.add(pIdx);
        }
        this.renderList();
      });

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "province-name-input";
      nameInput.value = province.name;
      nameInput.addEventListener("change", (e) => {
        province.name = (e.target as HTMLInputElement).value;
        this.canvasManager.scheduleRender();
      });
      nameInput.addEventListener("mousedown", (e) => e.stopPropagation());
      nameInput.addEventListener("click", (e) => e.stopPropagation());

      const locateBtn = document.createElement("button");
      locateBtn.className = "city-locate-btn";
      locateBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M12,2c-4.42,0-8,3.58-8,8c0,5.25,8,12,8,12s8-6.75,8-12C20,5.58,16.42,2,12,2z M12,13c-1.66,0-3-1.34-3-3s1.34-3,3-3s3,1.34,3,3S13.66,13,12,13z"/>
        </svg>
      `;
      locateBtn.style.opacity = "0.6";
      locateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.canvasManager.lookAt(
          province.centroidX ?? province.seatX ?? 0,
          province.centroidY ?? province.seatY ?? 0,
          Math.max(this.canvasManager.scale, 5),
        );
      });
      locateBtn.title = province.area
        ? `${province.area.toLocaleString()} km² · pop. ${(province.population ?? 0).toLocaleString()}`
        : "Locate Province";

      const deleteProvinceBtn = document.createElement("button");
      deleteProvinceBtn.className = "city-delete-btn";
      deleteProvinceBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4Z M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
        </svg>
      `;
      deleteProvinceBtn.title = "Abolish Province";
      deleteProvinceBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await this.uiManager.confirm(
          "ABOLISH PROVINCE",
          `Are you sure you want to abolish ${province.name}? Its territories will revert to direct national control.`,
        );
        if (confirmed) {
          this.deleteProvince(pIdx);
        }
      });

      item.appendChild(toggleBtn);
      item.appendChild(nameInput);
      item.appendChild(locateBtn);
      item.appendChild(deleteProvinceBtn);

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectedNationIndex = nationIdx;
        this.selectedProvinceIndex = pIdx;
        this.canvasManager.lookAt(
          province.centroidX ?? province.seatX ?? 0,
          province.centroidY ?? province.seatY ?? 0,
          Math.max(this.canvasManager.scale, 5),
        );
        this.renderList();
      });

      item.addEventListener("mouseenter", () => {
        this.hoveredProvinceIndex = pIdx;
        this.canvasManager.scheduleRender();
      });
      item.addEventListener("mouseleave", () => {
        this.hoveredProvinceIndex = -1;
        this.canvasManager.scheduleRender();
      });

      container.appendChild(item);

      const cityListContainer = document.createElement("div");
      cityListContainer.id = `city-list-container-p-${pIdx}`;
      container.appendChild(cityListContainer);

      if (this.expandedProvinces.has(pIdx)) {
        this.renderCityList(nationIdx, pIdx, cityListContainer);
      }
    });

    if (nationProvinces.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.className = "city-empty-msg";
      emptyMsg.textContent = "No provinces established";
      container.appendChild(emptyMsg);
    }

    if (nationIdx !== -1) {
      const addProvinceBtn = document.createElement("button");
      addProvinceBtn.className = `province-add-btn ${this.provincePlacementMode === nationIdx ? "active" : ""}`;
      addProvinceBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
        </svg>
        <span>${this.provincePlacementMode === nationIdx ? "CANCEL CREATION" : "NEW PROVINCE"}</span>
      `;
      addProvinceBtn.addEventListener("click", () => {
        if (this.provincePlacementMode === nationIdx) {
          this.provincePlacementMode = -1;
        } else {
          this.provincePlacementMode = nationIdx;
          this.cityPlacementMode = -1;
        }
        this.renderList();
        this.canvasManager.scheduleRender();
      });
      container.appendChild(addProvinceBtn);
    }
  }

  private getPopulation(city: City): string {
    const pop = city.population;
    if (pop >= 1000000) return (pop / 1000000).toFixed(1) + "M";
    if (pop >= 1000) return (pop / 1000).toFixed(0) + "k";
    return Math.floor(pop).toString();
  }

  private renderCityList(
    nationIdx: number,
    provinceIdx: number,
    container: HTMLElement,
  ) {
    const world = this.generator.getWorld();
    container.innerHTML = "";
    container.className = "city-sub-list";

    let nationCities = world.cities;
    if (provinceIdx !== -1) {
      nationCities = nationCities.filter(
        (c) => c.provinceIndex === provinceIdx,
      );
    } else if (nationIdx !== -1) {
      // Show ALL cities in the nation (Flat List)
      nationCities = nationCities.filter((c) => c.nationIndex === nationIdx);
    } else {
      // Unaffiliated cities
      nationCities = nationCities.filter((c) => c.nationIndex === -1);
    }

    nationCities.sort((a, b) => b.size - a.size);

    nationCities.forEach((city) => {
      const isPending = this.pendingCityIds.has(city.id);
      const cityItem = document.createElement("div");
      cityItem.className = `city-item ${city.isCapital ? "is-capital" : ""} ${isPending ? "loading" : ""}`;

      if (isPending) {
        const spinner = document.createElement("div");
        spinner.className = "spinner";
        cityItem.appendChild(spinner);

        const loadingText = document.createElement("span");
        loadingText.className = "loading-text";
        loadingText.textContent = " Founding...";
        loadingText.style.fontSize = "0.7rem";
        loadingText.style.color = "var(--accent)";
        cityItem.appendChild(loadingText);
        container.appendChild(cityItem);
        return;
      }

      let capitalBtn: HTMLButtonElement | null = null;
      if (nationIdx !== -1) {
        capitalBtn = document.createElement("button");
        capitalBtn.className = `city-capital-btn ${city.isCapital ? "active" : ""}`;
        capitalBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
            <path d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z"/>
          </svg>
        `;
        capitalBtn.title = city.isCapital
          ? "Capital City"
          : "Assign as Capital";
        capitalBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (city.isCapital) return;
          const oldCapital = nationCities.find((c) => c.isCapital);
          if (oldCapital) oldCapital.isCapital = false;
          city.isCapital = true;
          const nation = world.nations[nationIdx];
          if (nation) {
            nation.capitalX = city.x;
            nation.capitalY = city.y;
          }
          this.updateNationUI(nationIdx);
          this.canvasManager.scheduleRender();
        });
      }

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
      popInfo.textContent = this.getPopulation(city);

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
        this.focusCity(city);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "city-delete-btn";
      deleteBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4Z M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
        </svg>
      `;
      deleteBtn.title = "Delete City";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await this.uiManager.confirm(
          "RAZE SETTLEMENT",
          `Are you sure you want to raze ${city.name}? This action is permanent.`,
        );
        if (confirmed) {
          this.deleteCity(city.id);
        }
      });

      if (capitalBtn) cityItem.appendChild(capitalBtn);
      cityItem.appendChild(nameInput);
      cityItem.appendChild(popInfo);
      cityItem.appendChild(locateBtn);
      cityItem.appendChild(deleteBtn);
      container.appendChild(cityItem);
    });

    if (nationCities.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.className = "city-empty-msg";
      emptyMsg.textContent = "No cities founded yet";
      container.appendChild(emptyMsg);
    }

    if (nationIdx !== -1) {
      const addCityBtn = document.createElement("button");
      addCityBtn.className = `city-add-btn ${this.cityPlacementMode === nationIdx ? "active" : ""}`;
      addCityBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
        </svg>
        <span>${this.cityPlacementMode === nationIdx ? "CANCEL CREATION" : "NEW CITY"}</span>
      `;
      addCityBtn.addEventListener("click", () => {
        if (this.cityPlacementMode === nationIdx) {
          this.cityPlacementMode = -1;
        } else {
          this.cityPlacementMode = nationIdx;
          this.provincePlacementMode = -1;
          // Assign to province if one is selected
          this.pendingProvinceIdx = provinceIdx;
        }
        this.renderList();
        this.canvasManager.scheduleRender();
      });
      container.appendChild(addCityBtn);
    }
  }

  private pendingProvinceIdx: number = -1;

  public async addProvince(nationIndex: number, x: number, y: number) {
    const world = this.generator.getWorld();
    const nation = world.nations[nationIndex];
    if (!nation) return;
    const cell = world.getCell(x, y);
    this.provincePlacementMode = -1;
    if (!cell || cell.isWater || cell.nationIndex !== nationIndex) {
      this.renderList();
      return;
    }
    // Regrow this nation's provinces with the new seat added, so the new
    // province takes its natural, terrain-following share of territory (and a
    // name from the local culture and geography).
    partitionNation(world, this.generator.getNoise(), nationIndex, [{ x, y, cityId: -1 }], true);

    this.gpuRenderer.updateProvincesDataTexture(world);
    this.renderList();
    this.canvasManager.scheduleRender();
  }

  public deleteProvince(provinceId: number) {
    const world = this.generator.getWorld();
    const provinceIdx = world.provinces.findIndex((p) => p.id === provinceId);
    if (provinceIdx === -1) return;

    world.provinces.splice(provinceIdx, 1);
    // Single-pass re-index: removed -> direct rule (-1), others shift down
    const remap = new Map<number, number>();
    world.provinces.forEach((p, idx) => {
      remap.set(p.id, idx);
      p.id = idx;
    });
    const fix = (v: number | undefined) =>
      v === undefined || v < 0 ? v : v === provinceId ? -1 : (remap.get(v) ?? -1);
    for (let x = 0; x < world.width; x++) {
      const col = world.grid[x];
      for (let y = 0; y < world.height; y++) col[y].provinceIndex = fix(col[y].provinceIndex);
    }
    world.cities.forEach((c) => (c.provinceIndex = fix(c.provinceIndex)));

    if (this.selectedProvinceIndex === provinceId) {
      this.selectedProvinceIndex = -1;
    }

    this.gpuRenderer.updateProvincesDataTexture(world);
    this.renderList();
    this.canvasManager.scheduleRender();
  }

  public async addNation(x: number, y: number) {
    const world = this.generator.getWorld();
    const startX = x;
    const startY = y;

    // Name, culture and faith come from the people living at the founding spot
    const here = world.getCell(startX, startY);
    const lang = world.languages[here?.cultureIndex ?? 0];
    const newNation: Nation = {
      id: 0,
      name: lang ? lang.nationName() : "New Nation",
      color: colorForNewNation(
        world,
        [...new Set([-1, 0, 1].flatMap((d) => [world.getCell(startX + d * 4, startY)?.nationIndex ?? -1, world.getCell(startX, startY + d * 4)?.nationIndex ?? -1]))].filter((i) => i >= 0),
      ),
      capitalX: startX,
      capitalY: startY,
      cultureId: here?.cultureIndex ?? 0,
      religionId: here?.religionIndex ?? 0,
      government: lang ? lang.government(0.1, false) : "Kingdom",
    };

    // 1. Shift existing nations and re-index them
    world.nations.forEach((n) => n.id++);
    world.nations.unshift(newNation);

    // 2. Re-index EVERY cell in the grid (including water, as it may have a nationIndex)
    // This is safer than using nationCellsList which might miss certain areas.
    for (let xPos = 0; xPos < world.width; xPos++) {
      for (let yPos = 0; yPos < world.height; yPos++) {
        const cell = world.grid[xPos][yPos];
        if (cell.nationIndex !== undefined && cell.nationIndex !== -1) {
          cell.nationIndex++;
        }
      }
      // Yield periodically to keep UI responsive on massive maps
      if (xPos % 200 === 0) await new Promise((r) => requestAnimationFrame(r));
    }

    // 3. Update all nationIndex references in cities
    world.cities.forEach((city) => {
      if (city.nationIndex !== -1) {
        city.nationIndex++;
      }
    });

    // 4. Update internal state lists
    this.nationCellsList.unshift(new Set());
    this.nationCentroids.unshift({ x: startX, y: startY });
    this.nationSizes.unshift(0);
    this.nationLandArea.unshift(0);

    // 5. Shift expandedNations state
    const newExpanded = new Set<number>();
    this.expandedNations.forEach((idx) => {
      if (idx === -1) newExpanded.add(-1);
      else newExpanded.add(idx + 1);
    });
    this.expandedNations = newExpanded;

    // 6. Adjust selected index
    if (this.selectedNationIndex !== -1) {
      this.selectedNationIndex++;
    }

    await new Promise((r) => requestAnimationFrame(r));

    // 7. Paint circular starting territory
    const radius = 12;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (dx * dx + dy * dy <= radius * radius) {
          const px = (startX + (dx % world.width) + world.width) % world.width;
          const py = startY + dy;
          if (py >= 0 && py < world.height) {
            const cell = world.grid[px][py];
            if (!cell.isWater) {
              const oldNationIdx = cell.nationIndex;
              if (oldNationIdx !== undefined && oldNationIdx !== -1) {
                this.nationCellsList[oldNationIdx]?.delete(
                  py * world.width + px,
                );
              }
              cell.nationIndex = 0;
              this.nationCellsList[0].add(py * world.width + px);
            }
          }
        }
      }
    }

    this.nationPlacementMode = false;
    this.nationsStateDirty = true;
    this.buildCache();

    // 8. Add capital city (async)
    await this.addCity(0, startX, startY, true);

    // Final UI refresh
    this.renderList();
    this.canvasManager.scheduleRender();

    // Select the new nation
    this.selectedNationIndex = 0;
    this.expandedNations.add(0);
    this.renderList();

    setTimeout(() => {
      const target = document.querySelector(`.nation-item[data-index="0"]`);
      target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 100);
  }

  public async addCity(
    nationIndex: number,
    x: number,
    y: number,
    isCapital: boolean = false,
  ) {
    const world = this.generator.getWorld();
    const nation = world.nations[nationIndex];
    if (!nation) return;
    if (world.sampler.isWater(x, y)) return;

    const cell = world.getCell(x, y);
    const newCity: City = {
      id: world.cities.length,
      name: cityNameFor(world, x, y, Math.random),
      x,
      y,
      nationIndex,
      provinceIndex: this.pendingProvinceIdx >= 0 ? this.pendingProvinceIdx : (cell?.provinceIndex ?? -1),
      isCapital,
      size: isCapital ? 2 : 0,
      population: 0,
      radiusM: 0,
      seed: 0,
    };
    finalizeCity(world, newCity, cell?.populationDensity ?? 0.3);
    this.pendingProvinceIdx = -1;
    this.cityPlacementMode = -1;

    world.cities.push(newCity);
    connectCity(world, newCity);
    world.roadsEdited = true;
    this.renderList();
    this.canvasManager.scheduleRender();
  }

  public deleteCity(cityId: number) {
    const world = this.generator.getWorld();
    const cityIndex = world.cities.findIndex((c) => c.id === cityId);
    if (cityIndex === -1) return;

    const city = world.cities[cityIndex];
    const nationIndex = city.nationIndex;

    world.cities.splice(cityIndex, 1);
    this.cityRenderer.invalidateCity(city);
    world.worldRoads = world.worldRoads.filter((r) => r.a !== city.id && r.b !== city.id);
    world.roadsEdited = true;

    // If it was capital, find another city in the same nation to be capital
    if (city.isCapital) {
      const nationCities = world.cities.filter(
        (c) => c.nationIndex === nationIndex,
      );
      if (nationCities.length > 0) {
        // Find largest city to be new capital
        nationCities.sort((a, b) => b.size - a.size);
        const newCapital = nationCities[0];
        newCapital.isCapital = true;
        const nation = world.nations[nationIndex];
        if (nation) {
          nation.capitalX = newCapital.x;
          nation.capitalY = newCapital.y;
        }
      }
    }

    // Re-index city IDs to keep them sequential
    world.cities.forEach((c, idx) => (c.id = idx));

    this.renderList();
    this.canvasManager.scheduleRender();
  }

  public async deleteNation(nationIndex: number) {
    const world = this.generator.getWorld();
    if (nationIndex < 0 || nationIndex >= world.nations.length) return;

    // 1. Release cities of this nation (make them independent villages/towns)
    world.cities.forEach((c) => {
      if (c.nationIndex === nationIndex) {
        c.nationIndex = -1;
        c.isCapital = false;
      } else if (c.nationIndex > nationIndex) {
        c.nationIndex--;
      }
    });

    // 2. Clear territory and re-index grid
    for (let x = 0; x < world.width; x++) {
      for (let y = 0; y < world.height; y++) {
        const cell = world.grid[x][y];
        if (cell.nationIndex === nationIndex) {
          cell.nationIndex = -1;
          cell.isNationBorder = false;
        } else if (
          cell.nationIndex !== undefined &&
          cell.nationIndex > nationIndex
        ) {
          cell.nationIndex--;
        }
      }
      if (x % 200 === 0) await new Promise((r) => requestAnimationFrame(r));
    }

    // 3. Re-index city IDs to keep them sequential
    world.cities.forEach((c, idx) => (c.id = idx));

    // 4. Remove from world.nations
    world.nations.splice(nationIndex, 1);

    // 5. Update internal state
    this.nationCellsList.splice(nationIndex, 1);
    this.nationCentroids.splice(nationIndex, 1);
    this.nationSizes.splice(nationIndex, 1);
    this.nationLandArea.splice(nationIndex, 1);

    // 6. Shift expandedNations and selectedNationIndex
    const newExpanded = new Set<number>();
    this.expandedNations.forEach((idx) => {
      if (idx < nationIndex) newExpanded.add(idx);
      else if (idx > nationIndex) newExpanded.add(idx - 1);
    });
    this.expandedNations = newExpanded;

    if (this.selectedNationIndex === nationIndex) {
      this.selectedNationIndex = -1;
    } else if (this.selectedNationIndex > nationIndex) {
      this.selectedNationIndex--;
    }

    this.nationsStateDirty = true;
    this.buildCache();
    this.renderList();
    this.canvasManager.scheduleRender();
  }

  // The figure shown on a nation row follows the active sort
  private metricText(idx: number): string {
    const st = this.stats[idx];
    switch (this.sortKey) {
      case "population":
        return st ? `${compact(st.population)} people` : "";
      case "cities":
        return st ? `${st.cities} settlements` : "";
      case "wealth":
        return st ? `${compact(st.wealth)} wealth` : "";
      default:
        return `${((this.nationLandArea[idx] || 0) * CELL_KM2).toLocaleString()} km²`;
    }
  }

  private updateNationUI(idx: number) {
    if (idx < 0) return;
    const territoryCount = document.getElementById(
      `nation-territory-count-${idx}`,
    );
    if (territoryCount) territoryCount.textContent = this.metricText(idx);

    if (this.expandedNations.has(idx)) {
      const container = document.getElementById(`city-list-container-${idx}`);
      if (container) {
        this.renderProvinceList(idx, container);
      }
    }
  }

  private buildCityMap() {
    this.cityMap.clear();
    const world = this.generator.getWorld();
    world.cities.forEach((city) => {
      const flatIdx = Math.floor(city.y) * world.width + Math.floor(city.x);
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

    let minX = wx,
      maxX = wx,
      minY = wy,
      maxY = wy;

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
    const dirtyW = maxX - minX + 1 + padding * 2;
    const dirtyH = maxY - minY + 1 + padding * 2;

    if (dirtyW > 0 && dirtyH > 0) {
      this.gpuRenderer.updateNationsDataTexture(world, {
        x: dirtyX,
        y: dirtyY,
        w: dirtyW,
        h: dirtyH,
      });
      // Also update provinces texture for borders
      this.gpuRenderer.updateProvincesDataTexture(world, {
        x: dirtyX,
        y: dirtyY,
        w: dirtyW,
        h: dirtyH,
      });
    }

    this.canvasManager.scheduleRender();
    affectedNations.forEach((idx) => this.updateNationUI(idx));
  }

  private relocateCapital(nationIdx: number) {
    const world = this.generator.getWorld();
    const nation = world.nations[nationIdx];
    if (!nation) return;
    const successor = world.cities
      .filter((c) => c.nationIndex === nationIdx)
      .sort((a, b) => b.population - a.population)[0];
    if (!successor) return;
    successor.isCapital = true;
    nation.capitalX = successor.x;
    nation.capitalY = successor.y;
    this.cityRenderer.invalidateCity(successor);
  }

  public stopPainting() {
    if (this.isPainting) {
      this.isPainting = false;
      this.lastPaintedX = null;
      this.lastPaintedY = null;
      this.updateStatistics();
      this.renderList();
      this.canvasManager.scheduleRender();
    }
  }

  private paintAt(
    wx: number,
    wy: number,
    affectedCells: Set<number>,
    affectedNations: Set<number>,
  ) {
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
              if (!cell.isWater) this.nationLandArea[oldIdx]--;
              affectedNations.add(oldIdx);
            }
            this.nationCellsList[this.selectedNationIndex].add(flatIdx);
            if (!cell.isWater) this.nationLandArea[this.selectedNationIndex]++;

            // Update city ownership if a city exists at this coordinate
            const city = this.cityMap.get(flatIdx);
            if (city) {
              const previous = city.nationIndex;
              city.nationIndex = this.selectedNationIndex;
              city.provinceIndex = -1; // Reset province when nation changes
              // An occupied capital becomes an ordinary city of the occupier,
              // and the defeated nation moves its seat to its largest city
              if (city.isCapital && previous !== this.selectedNationIndex) {
                city.isCapital = false;
                this.cityRenderer.invalidateCity(city);
                this.relocateCapital(previous);
              }
            }
          }

          // If painting inside the currently selected nation
          if (cell.nationIndex === this.selectedNationIndex) {
            cell.provinceIndex = this.selectedProvinceIndex;
            const flatIdx = ty * world.width + wrappedX;
            const city = this.cityMap.get(flatIdx);
            if (city) {
              city.provinceIndex = this.selectedProvinceIndex;
            }
          }

          // Mark for border update later
          for (let bdx = -1; bdx <= 1; bdx++) {
            for (let bdy = -1; bdy <= 1; bdy++) {
              const bwx = tx + bdx;
              const bwy = ty + bdy;
              if (bwy >= 0 && bwy < world.height) {
                const bwWrappedX =
                  ((bwx % world.width) + world.width) % world.width;
                affectedCells.add(bwy * world.width + bwWrappedX);
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

    affectedCells.forEach((flatIdx) => {
      const x = flatIdx % W;
      const y = Math.floor(flatIdx / W);
      const cell = world.grid[x][y];
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
            if ((nb.nationIndex ?? -1) !== nid) {
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
    this.nationLandArea = world.nations.map(() => 0);

    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell.nationIndex !== undefined && cell.nationIndex >= 0 && cell.nationIndex < world.nations.length) {
          this.nationCellsList[cell.nationIndex].add(y * W + x);
          if (!cell.isWater) this.nationLandArea[cell.nationIndex]++;
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
    const TAU = Math.PI * 2;

    for (let i = 0; i < world.nations.length; i++) {
      const cells = this.nationCellsList[i];
      const area = cells.size;
      if (area > maxArea) maxArea = area;

      if (area > 0) {
        let sumSin = 0;
        let sumCos = 0;
        let sumYWeighted = 0;
        let totalWeight = 0;

        cells.forEach((flatIdx) => {
          const x = flatIdx % W;
          const y = Math.floor(flatIdx / W);
          const cell = world.grid[x][y];

          // Land-Priority Weighting: Land cells influence label position 10x more than sea
          const weight = cell.isWater ? 1.0 : 10.0;

          // Circular Mean for X (handles cylindrical wraparound)
          const angle = (x / W) * TAU;
          sumSin += Math.sin(angle) * weight;
          sumCos += Math.cos(angle) * weight;

          sumYWeighted += y * weight;
          totalWeight += weight;
        });

        const avgAngle = Math.atan2(sumSin, sumCos);
        let avgX = (avgAngle / TAU) * W;
        if (avgX < 0) avgX += W;

        this.nationCentroids[i] = { x: avgX, y: sumYWeighted / totalWeight };
      } else {
        this.nationCentroids[i] = {
          x: world.nations[i]?.capitalX || 0,
          y: world.nations[i]?.capitalY || 0,
        };
      }
    }

    // Label sizes follow land area, not claimed sea
    const maxLand = Math.max(1, ...this.nationLandArea);
    for (let i = 0; i < world.nations.length; i++) {
      this.nationSizes[i] = maxArea > 0 ? Math.sqrt((this.nationLandArea[i] || 0) / maxLand) : 0.5;
    }
    this.onTerritoryChanged?.();
  }
}
