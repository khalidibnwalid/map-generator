import './style.css';
import { CanvasManager } from './core/CanvasManager';
import { MapGenerator } from './game/MapGenerator';
import { Interface } from './ui/Interface';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="ui-panel" class="tech-panel">
    <div class="tech-corner top-left"></div>
    <div class="tech-corner top-right"></div>
    <div class="tech-corner bottom-left"></div>
    <div class="tech-corner bottom-right"></div>
    <div class="panel-header">
      <span class="header-icon">⬡</span>
      <h1>SYSTEM CONFIG</h1>
      <span class="header-line"></span>
      <button id="toggle-panel" class="toggle-btn" title="Toggle Panel">[-]</button>
    </div>
    
    <div id="panel-content" class="panel-content">
      <div class="control-group">
      <label for="preset">[PARAM] PRESET</label>
      <div class="select-wrapper">
        <select id="preset">
          <option value="Heavy Landmass">Heavy Landmass</option>
          <option value="Realistic Continents">Realistic Continents</option>
          <option value="Mediterranean Archipelago">Mediterranean Archipelago</option>
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
        <input type="number" id="seed" value="123456" />
        <button id="generate" class="btn-primary">INITIATE //></button>
      </div>
    </div>
    
    <div class="control-group layers-group">
      <label>[VIEW] LAYERS [■■■■]</label>
      <div class="layers">
        <button id="layer-biomes" class="layer-btn active">BIOMES</button>
        <button id="layer-elevation" class="layer-btn">ELEVATION</button>
        <button id="layer-heatmap" class="layer-btn">HEATMAP</button>
        <button id="layer-moisture" class="layer-btn">MOISTURE</button>
        <button id="layer-nations" class="layer-btn layer-btn--full">NATIONS</button>
      </div>
    </div>
    </div>
  </div>
  <canvas id="mapCanvas"></canvas>
  <div id="nation-tooltip" class="nation-tooltip" style="display:none;">
    <div class="tooltip-name"></div>
    <div class="tooltip-detail"></div>
  </div>
`;

// Initialize
const canvasManager = new CanvasManager('mapCanvas');
// Generate an 800x450 map logic cells size (16:9 aspect ratio), will be rendered scaling to screen via Interface
const generator = new MapGenerator(800, 450, 123456);
new Interface(generator, canvasManager);

// Initial Generation
generator.generate();

// First render
// Default scale to fit height perfectly
const fitScale = window.innerHeight / 450;
canvasManager.scale = fitScale;
canvasManager.offsetX = (window.innerWidth - (800 * canvasManager.scale)) / 2;
canvasManager.offsetY = 0;
canvasManager.scheduleRender();
