// use vscode extension 'es6-string-html' for your mental health :D

const icon = (d: string) =>
  /* html */ `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  world: icon(`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`),
  layers: icon(`<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>`),
  nations: icon(`<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>`),
  file: icon(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>`),
  close: icon(`<path d="M6 6l12 12M18 6 6 18"/>`),
  dice: icon(`<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>`),
  plus: icon(`<path d="M12 5v14M5 12h14"/>`),
  minus: icon(`<path d="M5 12h14"/>`),
  home: icon(`<path d="M4 10 12 4l8 6v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>`),
  save: icon(`<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>`),
  open: icon(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a2 2 0 0 0 2 2h13l3-8H6l-3 8"/>`),
  build: icon(`<path d="M3 21h18M5 21V10l7-5 7 5v11"/><path d="M10 21v-6h4v6"/>`),
  history: icon(`<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/>`),
  play: icon(`<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>`),
  pause: icon(`<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor"/>`),
  step: icon(`<path d="M5 4.5v15l10-7.5z" fill="currentColor"/><path d="M18 5v14"/>`),
  edit: icon(`<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>`),
  poster: icon(`<rect x="3" y="4" width="18" height="16" rx="1.5"/><rect x="6" y="7" width="12" height="10" rx="0.5"/><path d="m6 15 3.5-3.5 2.5 2.5 2-2 4 4"/>`),
  image: icon(`<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>`),
};

const toggle = (id: string, label: string, checked: boolean, hint = "") => /* html */ `
  <label class="switch-row">
    <span class="switch-text">${label}${hint ? `<small>${hint}</small>` : ""}</span>
    <input type="checkbox" id="${id}" ${checked ? "checked" : ""} />
    <span class="switch"></span>
  </label>`;

// Visual pickers drive hidden <select>s so existing logic keeps reading them
const picker = (selectId: string, cls: string, options: { value: string; label: string; sub?: string; swatch?: string }[], selected: string) => /* html */ `
  <select id="${selectId}" class="visually-hidden" tabindex="-1">
    ${options.map((o) => `<option value="${o.value}" ${o.value === selected ? "selected" : ""}>${o.label}</option>`).join("")}
  </select>
  <div class="picker ${cls}" data-for="${selectId}">
    ${options
      .map(
        (o) => /* html */ `<button type="button" class="pick ${o.value === selected ? "active" : ""}" data-value="${o.value}">
          ${o.swatch ? `<span class="pick-swatch" style="background:${o.swatch}"></span>` : ""}
          <span class="pick-label">${o.label}</span>${o.sub ? `<span class="pick-sub">${o.sub}</span>` : ""}
        </button>`,
      )
      .join("")}
  </div>`;

export function refreshPickers() {
  document.querySelectorAll<HTMLElement>(".picker").forEach((p) => {
    const sel = document.getElementById(p.dataset.for!) as HTMLSelectElement | null;
    if (!sel) return;
    p.querySelectorAll<HTMLElement>(".pick").forEach((b) => b.classList.toggle("active", b.dataset.value === sel.value));
  });
}

export default function renderMainApp() {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = /* html */ `
      <nav class="rail">
        <div class="rail-logo" title="Procedural World Generator">
          <img src="${import.meta.env.BASE_URL}favicon.svg" width="34" height="34" alt="Map Generator logo" />
        </div>
        <button id="tab-generate" class="rail-btn active" title="World">${ICONS.world}<span>World</span></button>
        <button id="tab-layers" class="rail-btn" title="Layers">${ICONS.layers}<span>Layers</span></button>
        <button id="tab-nations" class="rail-btn" title="Nations">${ICONS.nations}<span>Nations</span></button>
        <button id="tab-build" class="rail-btn" title="Build">${ICONS.build}<span>Build</span></button>
        <button id="tab-history" class="rail-btn" title="History">${ICONS.history}<span>History</span></button>
        <button id="tab-file" class="rail-btn" title="File">${ICONS.file}<span>File</span></button>
      </nav>

      <aside id="ui-panel" class="panel">
        <header class="panel-header">
          <h2 id="panel-title">World</h2>
          <button id="toggle-panel" class="icon-btn" title="Close panel">${ICONS.close}</button>
        </header>

        <div id="panel-content" class="panel-content">
          <!-- World -->
          <section id="content-generate" class="tab-content active">
            <div class="field">
              <div class="field-label">Landmass</div>
              ${picker(
                "preset",
                "grid-2",
                [
                  { value: "Heavy Landmass", label: "Heavy", sub: "Large continents" },
                  { value: "Realistic Continents", label: "Continents", sub: "Earth-like" },
                  { value: "Earthlike", label: "Earthlike", sub: "Tectonic continents" },
                  { value: "Pangea", label: "Pangea", sub: "One supercontinent" },
                ],
                "Heavy Landmass",
              )}
            </div>

            <div class="field">
              <div class="field-label">Or shape it from an image</div>
              <button id="guide-import" class="file-card">
                ${ICONS.image}
                <span><strong>Import image</strong><small>Sketch, silhouette, colored map or heightmap</small></span>
              </button>
              <div id="guide-card" class="guide-card" style="display:none">
                <canvas id="guide-thumb" class="guide-thumb" width="112" height="63"></canvas>
                <span class="guide-info"><strong id="guide-name">Image</strong><small>Generate keeps this land and reseeds the rest</small></span>
                <button id="guide-edit" class="icon-btn" title="Adjust the import">${ICONS.edit}</button>
                <button id="guide-clear" class="icon-btn" title="Back to the landmass presets">${ICONS.close}</button>
              </div>
            </div>

            <div class="field">
              <div class="field-label">Size</div>
              ${picker(
                "size",
                "segmented",
                [
                  { value: "400x225", label: "S" },
                  { value: "800x450", label: "M" },
                  { value: "1600x900", label: "L" },
                  { value: "3200x1800", label: "XL" },
                ],
                "800x450",
              )}
            </div>

            <div class="field">
              <div class="field-label">Great powers</div>
              ${picker(
                "great-powers",
                "segmented",
                [
                  { value: "0", label: "None" },
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "3", label: "3" },
                ],
                "1",
              )}
            </div>

            <div class="field">
              <div class="field-label">Seed</div>
              <div class="seed-row">
                <input type="number" id="seed" value="0" />
                <button id="seed-random" class="icon-btn boxed" title="Random seed">${ICONS.dice}</button>
              </div>
            </div>

            <button id="generate" class="btn-primary wide">Generate world</button>
          </section>

          <!-- Layers -->
          <section id="content-layers" class="tab-content">
            <div class="field">
              <div class="field-label">Map style</div>
              ${picker(
                "theme",
                "grid-3 cards",
                [
                  { value: "Realistic", label: "Realistic", swatch: "linear-gradient(135deg,#1e4f75 0 45%,#5f8f45 45% 75%,#c9b47b 75%)" },
                  { value: "Historical", label: "Historical", swatch: "linear-gradient(135deg,#a9bcb6 0 45%,#e8d9b2 45% 80%,#8a6a45 80%)" },
                  { value: "Atlas", label: "Atlas", swatch: "linear-gradient(135deg,#a9cde8 0 45%,#f0c8b0 45% 70%,#c8e0b0 70%)" },
                ],
                "Realistic",
              )}
            </div>

            <div class="field">
              <div class="field-label">Terrain</div>
              <div class="segmented radio-seg">
                <label><input type="radio" name="base-layer" value="Biomes" checked /><span>Biomes</span></label>
                <label><input type="radio" name="base-layer" value="Elevation" /><span>Elevation</span></label>
              </div>
            </div>

            <div class="field">
              <div class="field-label">Thematic map</div>
              ${picker(
                "thematic",
                "grid-2 chips",
                [
                  { value: "none", label: "Political" },
                  { value: "cultures", label: "Cultures" },
                  { value: "diplomacy", label: "Diplomacy" },
                  { value: "wealth", label: "Wealth" },
                ],
                "none",
              )}
            </div>

            <div class="group">
              <div class="group-title">Political</div>
              ${toggle("layer-nations", "Nations", true)}
              ${toggle("layer-borders", "Borders", true)}
              ${toggle("layer-provinces", "Provinces", true)}
              ${toggle("layer-flags", "Flags", true, "above nation names")}
              ${toggle("layer-wars", "Wars & battles", true, "fronts, offensives, battles")}
            </div>
            <div class="group">
              <div class="group-title">Nature</div>
              ${toggle("layer-rivers", "Rivers", true)}
              ${toggle("layer-ice", "Polar ice", true)}
              ${toggle("layer-currents", "Ocean currents", false, "warm & cold flows")}
            </div>
            <div class="group">
              <div class="group-title">Settlements & trade</div>
              ${toggle("layer-cities", "Cities", true)}
              ${toggle("layer-roads", "Roads", true)}
              ${toggle("layer-searoutes", "Sea routes", true)}
              ${toggle("layer-trade", "Trade flows", false, "caravans & shipping")}
              ${toggle("layer-pois", "Landmarks", true)}
              ${toggle("layer-resources", "Resources", true)}
              ${toggle("layer-labels", "Labels", true)}
            </div>
            <div class="group">
              <div class="group-title">Atmosphere</div>
              ${toggle("layer-season", "Seasons", false, "snow, foliage & sea ice by month")}
              <div class="season-row" id="season-row">
                <input type="range" id="season-month" min="0" max="11" step="0.05" value="0" aria-label="Month" />
                <span id="season-month-label" class="season-month">January</span>
              </div>
              ${toggle("layer-night", "Night", false, "moonlight & city lights")}
              ${toggle("layer-weather", "Weather", false, "drifting clouds")}
            </div>
            <div class="group">
              <div class="group-title">Data overlays</div>
              ${toggle("layer-heatmap", "Temperature", false)}
              ${toggle("layer-population", "Population", false)}
              ${toggle("layer-moisture", "Moisture", false)}
            </div>
          </section>

          <!-- Nations -->
          <section id="content-nations" class="tab-content">
            <div class="nations-sticky">
            <div class="edit-mode-controls">
              <button id="btn-edit-nations" class="btn-ghost" title="Paint borders">${ICONS.edit}<span>Edit borders</span></button>
              <div class="brush-size-control">
                <span class="brush-label-overlay">Brush</span>
                <input type="range" id="brush-size" min="1" max="20" value="2" />
                <input type="number" id="brush-size-input" class="brush-number-input" min="1" max="100" value="2" />
              </div>
            </div>
            <div id="nations-head" class="nations-head"></div>
            </div>
            <div id="nations-list" class="nations-list">
              <!-- Dynamically populated -->
            </div>
          </section>

          <!-- Build -->
          <section id="content-build" class="tab-content">
            <div id="build-panel" class="build-panel"></div>
          </section>

          <!-- History -->
          <section id="content-history" class="tab-content">
            <p class="muted">Let time run. Nations settle empty land, fight over their frontiers and break apart. Mountains, rivers and fortresses slow invaders. Cohesion comes from culture, and strength from population, wealth and government. Rulers age and die, and houses rise and fall.</p>
            <div class="sim-controls">
              <button id="sim-play" class="btn-primary">${ICONS.play}<span>Play</span></button>
              <button id="sim-step" class="btn-ghost" title="Advance one year">${ICONS.step}<span>Step</span></button>
            </div>
            <div class="field">
              <div class="field-label">Speed (years per second)</div>
              ${picker(
                "sim-speed",
                "segmented",
                [
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "5", label: "5" },
                  { value: "10", label: "10" },
                ],
                "2",
              )}
            </div>
            <div class="sim-summary" id="sim-summary"></div>
            <div class="field sim-timeline" id="sim-timeline">
              <div class="field-label sim-timeline-head"><span>Timeline</span><span id="sim-scrub-year" class="sim-scrub-year"></span></div>
              <input type="range" id="sim-scrub" min="0" max="0" value="0" step="1" disabled />
              <div class="sim-timeline-row">
                <span id="sim-scrub-from" class="muted">–</span>
                <button id="sim-present" class="btn-ghost sim-present" disabled>Back to present</button>
                <span id="sim-scrub-to" class="muted">–</span>
              </div>
              <p class="muted sim-note">Drag to replay past borders. Replays are view-only: playing or stepping always continues from the present.</p>
              <button id="sim-gif" class="btn-ghost sim-gif" disabled><span class="sim-gif-label">Export GIF</span></button>
            </div>
            <div class="field war-room" id="war-room">
              <div class="field-label">Command a battle</div>
              <div class="war-room-row">
                <span class="war-room-label">Army of</span><div id="war-attacker" class="war-room-pick"></div>
                <button id="war-pick" class="icon-btn boxed war-pick" title="Pick the army's realm on the map">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l5 15 2.5-6.5L19 9z"/><path d="m13 13 6 6"/></svg>
                </button>
              </div>
              ${picker(
                "war-force",
                "segmented",
                [
                  { value: "1", label: "Skirmish" },
                  { value: "2", label: "Battle" },
                  { value: "3", label: "Rout" },
                ],
                "2",
              )}
              <button id="war-clear" class="btn-ghost war-clear" title="Remove battle marks, arrows and conquest borders; conquered land stays">Clear battle marks</button>
              <p class="muted sim-note" id="war-hint">Choose an army, then click any other realm's land on the map to attack it there. Your army always wins: it advances over the easiest ground, slowed by mountains, rivers and castles, and lands by sea when needed. Each battle is a step on the timeline.</p>
            </div>
            <div class="field">
            <div class="group-title">Chronicle</div>
            ${picker(
              "sim-filter",
              "segmented",
              [
                { value: "all", label: "All" },
                { value: "war", label: "Wars" },
                { value: "realm", label: "Realms" },
                { value: "ruler", label: "Rulers" },
              ],
              "all",
            )}
            <div id="sim-log" class="sim-log"><p class="muted">Nothing has happened yet.</p></div>
            </div>
          </section>

          <!-- File -->
          <section id="content-file" class="tab-content">
            <p class="muted">Worlds are saved as compact <code>.world</code> files: the seed plus every edit you made.</p>
            <button id="save-world" class="file-card">
              ${ICONS.save}
              <span><strong>Save world</strong><small>Download this world and its edits</small></span>
            </button>
            <button id="open-world" class="file-card">
              ${ICONS.open}
              <span><strong>Open world</strong><small>Load a .world file</small></span>
            </button>
            <input type="file" id="open-world-input" accept=".world" style="display:none" />
            <div class="group-title">Atlas</div>
            <button id="export-poster" class="file-card">
              ${ICONS.poster}
              <span><strong>Export poster</strong><small>High-resolution map with title, legend and frame</small></span>
            </button>
          </section>
        </div>
      </aside>

      <canvas id="mapCanvas"></canvas>

      <div class="map-controls">
        <button id="zoom-in" class="icon-btn" title="Zoom in">${ICONS.plus}</button>
        <button id="zoom-out" class="icon-btn" title="Zoom out">${ICONS.minus}</button>
        <button id="zoom-reset" class="icon-btn" title="Show whole world">${ICONS.home}</button>
      </div>

      <a
        class="gh-link"
        href="https://github.com/khalidibnwalid/map-generator"
        target="_blank"
        rel="noopener noreferrer"
        title="View on GitHub"
        aria-label="View on GitHub"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
        </svg>
      </a>

      <div id="sim-bar" class="sim-bar" style="display:none;">
        <button id="sim-bar-play" class="icon-btn" title="Play / pause">${ICONS.play}</button>
        <span class="sim-bar-year">Year <strong id="sim-bar-year">0</strong></span>
        <span id="sim-bar-event" class="sim-bar-event"></span>
      </div>

      <div id="nation-tooltip" class="nation-tooltip" style="display:none;">
        <div class="tooltip-name"></div>
        <div class="tooltip-detail"></div>
      </div>
      <div id="map-legend" class="map-legend" style="display:none;"></div>
      <div id="map-ruler" class="map-ruler" style="display:none;">
        <div class="ruler-line"></div>
        <div class="ruler-labels">
          <span class="ruler-label">0</span>
          <span class="ruler-label ruler-label-mid" id="ruler-text-mid"></span>
          <span class="ruler-label" id="ruler-text-end">100 km</span>
        </div>
      </div>
    `;

  // Pickers write to their hidden select and fire 'change'
  document.querySelectorAll<HTMLElement>(".picker").forEach((p) => {
    p.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".pick");
      const sel = document.getElementById(p.dataset.for!) as HTMLSelectElement | null;
      if (!btn || !sel) return;
      sel.value = btn.dataset.value!;
      sel.dispatchEvent(new Event("change"));
      refreshPickers();
    });
  });
  document.getElementById("seed-random")?.addEventListener("click", () => {
    const seed = document.getElementById("seed") as HTMLInputElement;
    seed.value = String(Math.floor(Math.random() * 999999));
  });
}
