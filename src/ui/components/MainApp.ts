// use vscode extension 'es6-string-html' for your mental health :D
export default function renderMainApp() {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML =
    /* html */ `  
      <div id="ui-panel" class="tech-panel">
        <div class="tech-corner top-left"></div>
        <div class="tech-corner top-right"></div>
        <div class="tech-corner bottom-left"></div>
        <div class="tech-corner bottom-right"></div>
        <div class="panel-header">
          <span class="header-icon">⬡</span>
          <h1>MAP</h1>
          <span class="header-line"></span>
          <button id="toggle-panel" class="toggle-btn" title="Toggle Panel">
            [-]
          </button>
        </div>

        <div class="panel-tabs">
          <button id="tab-generate" class="tab-btn active">GENERATE</button>
          <button id="tab-layers" class="tab-btn">LAYERS</button>
          <button id="tab-nations" class="tab-btn">NATIONS</button>
        </div>

        <div id="panel-content" class="panel-content">
          <!-- Generate Tab -->
          <div id="content-generate" class="tab-content active">
            <div class="control-group">
              <label for="preset">[PARAM] PRESET</label>
              <div class="select-wrapper">
                <select id="preset">
                  <option value="Heavy Landmass">Heavy Landmass</option>
                  <option value="Realistic Continents">
                    Realistic Continents
                  </option>
                  <option value="Mediterranean Archipelago">
                    Mediterranean Archipelago
                  </option>
                  <option value="Pangea">Pangea</option>
                </select>
              </div>
            </div>

            <div class="control-group">
              <label for="size">[PARAM] SIZE</label>
              <div class="select-wrapper">
                <select id="size">
                  <option value="400x225">Small (400x225)</option>
                  <option value="800x450" selected>Medium (800x450)</option>
                  <option value="1600x900">Large (1600x900)</option>
                  <option value="3200x1800">Epic (3200x1800)</option>
                </select>
              </div>
            </div>

            <div class="control-group">
              <label>[PARAM] SEED</label>
              <div class="input-row">
                <input type="number" id="seed" value="0" />
                <button id="generate" class="btn-primary">GENERATE</button>
              </div>
            </div>
          </div>

          <!-- Layers Tab -->
          <div id="content-layers" class="tab-content">
            <div class="control-group">
              <label>[VIEW] BASE LAYER</label>
              <div class="radio-group">
                <label class="radio-btn">
                  <input
                    type="radio"
                    name="base-layer"
                    value="Biomes"
                    checked
                  />
                  <span>BIOMES</span>
                </label>
                <label class="radio-btn">
                  <input type="radio" name="base-layer" value="Elevation" />
                  <span>ELEVATION</span>
                </label>
              </div>
            </div>

            <div class="control-group">
              <label>[VIEW] OVERLAYS</label>
              <div class="overlay-list">
                <label class="overlay-item">
                  <input type="checkbox" id="layer-nations" checked />
                  <span class="checkbox-box"></span>
                  <span class="label-text">NATIONS</span>
                </label>
                <label class="overlay-item">
                  <input type="checkbox" id="layer-borders" checked />
                  <span class="checkbox-box"></span>
                  <span class="label-text">BORDERS</span>
                </label>
                <label class="overlay-item">
                  <input type="checkbox" id="layer-heatmap" />
                  <span class="checkbox-box"></span>
                  <span class="label-text">HEATMAP</span>
                </label>
                <label class="overlay-item">
                  <input type="checkbox" id="layer-moisture" />
                  <span class="checkbox-box"></span>
                  <span class="label-text">MOISTURE</span>
                </label>
                <label class="overlay-item">
                  <input type="checkbox" id="layer-roads" checked />
                  <span class="checkbox-box"></span>
                  <span class="label-text">ROADS</span>
                </label>
                <label class="overlay-item">
                  <input type="checkbox" id="layer-cities" checked />
                  <span class="checkbox-box"></span>
                  <span class="label-text">CITIES</span>
                </label>
                <label class="overlay-item">
                  <input type="checkbox" id="layer-labels" checked />
                  <span class="checkbox-box"></span>
                  <span class="label-text">LABELS</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Nations Tab -->
          <div id="content-nations" class="tab-content">
            <div class="edit-mode-controls">
              <button
                id="btn-edit-nations"
                class="btn-icon"
                title="Toggle Edit Mode"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="currentColor"
                >
                  <path
                    d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"
                  />
                </svg>
              </button>
              <div class="brush-size-control">
                <span class="brush-label-overlay">BRUSH</span>
                <input
                  type="range"
                  id="brush-size"
                  min="1"
                  max="10"
                  value="2"
                />
                <span id="brush-size-value" class="brush-value-overlay">2</span>
              </div>
            </div>
            <div id="nations-list" class="nations-list">
              <!-- Dynamically populated -->
            </div>
          </div>
        </div>
      </div>
      <canvas id="mapCanvas"></canvas>
      <div id="nation-tooltip" class="nation-tooltip" style="display:none;">
        <div class="tooltip-name"></div>
        <div class="tooltip-detail"></div>
      </div>
      <div id="map-ruler" class="map-ruler" style="display:none;">
        <div class="ruler-line"></div>
        <div class="ruler-labels">
          <span class="ruler-label">0</span>
          <span class="ruler-label ruler-label-mid" id="ruler-text-mid"></span>
          <span class="ruler-label" id="ruler-text-end">100 km</span>
        </div>
      </div>
    `;
}
