import './style.css';
import { CanvasManager } from './core/CanvasManager';
import { MapGenerator } from './game/MapGenerator';
import { Interface } from './ui/Interface';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="ui-panel">
    <h1>World Generator</h1>
    <div class="control-group">
      <label for="preset">Preset:</label>
      <select id="preset">
        <option value="Heavy Landmass">Heavy Landmass</option>
        <option value="Realistic Continents">Realistic Continents</option>
        <option value="Mediterranean Archipelago">Mediterranean Archipelago</option>
        <option value="Pangea">Pangea</option>
      </select>
    </div>
    <div class="control-group">
      <label>Seed:</label>
      <input type="number" id="seed" value="123456" />
      <button id="generate" class="btn-primary">Generate</button>
    </div>
    <div class="control-group layers">
      <h3>Layers</h3>
      <button id="layer-biomes" class="layer-btn active">Biomes</button>
      <button id="layer-elevation" class="layer-btn">Elevation</button>
      <button id="layer-heatmap" class="layer-btn">Heatmap</button>
      <button id="layer-moisture" class="layer-btn">Moisture</button>
    </div>
  </div>
  <canvas id="mapCanvas"></canvas>
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
