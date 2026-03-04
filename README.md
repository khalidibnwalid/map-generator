# Procedural Worldbuilding Map Generator

A modular, high-performance procedural map generator using HTML5 Canvas and Vanilla JavaScript. Generate infinite variations of realistic worlds with terrain, elevation, hydrology, temperature, and biome systems.

## 🏗️ Architecture

The application follows a strict modular architecture across three main layers:

```
src/
├── core/                 # Low-level rendering and noise generation
│   ├── CanvasManager.js  # Canvas rendering, zoom/pan controls
│   └── NoiseEngine.js    # Perlin/Simplex noise implementation
├── game/                 # World data and generation logic
│   ├── WorldData.js      # Grid storage and layer management
│   └── MapGenerator.js   # Generation pipeline orchestration
├── ui/                   # User interface and visualization
│   └── Interface.js      # Controls, rendering modes, exports
├── main.ts               # Application entry point
└── style.css             # Styling
```

### Module Responsibilities

**Core Layer**
- `CanvasManager`: Handles all rendering, camera transformations, zoom/pan interactions
- `NoiseEngine`: Generates deterministic procedural noise using Perlin and FBM algorithms

**Game Layer**
- `WorldData`: Manages typed arrays for terrain and biome data with coordinate access methods
- `MapGenerator`: Orchestrates the 5-step generation pipeline

**UI Layer**
- `Interface`: Creates interactive controls, handles layer visualization, manages exports

## 🎮 Generation Pipeline

The map is generated in 5 sequential layers, each influencing the next:

### 1. **Elevation (Heightmap)**
- Uses FBM (Fractional Brownian Motion) with multiple octaves
- Latitude bias creates realistic polar-to-equator variation
- Ridge noise adds mountainous features
- Normalized to 0-1 range

```javascript
// Generated using:
fbm(x, y, octaves=6, persistence=0.5, lacunarity=2.0)
ridge(x, y, octaves=3, persistence=0.6, lacunarity=2.0)
```

### 2. **Moisture Map**
- Separate noise layer determining precipitation patterns
- Oceans have 70-100% moisture
- Moisture decreases with distance from coast on land
- Affects biome selection and vegetation

### 3. **Temperature Map**
- Based on latitude (sine wave from pole to equator)
- Decreases with elevation (atmospheric lapse rate)
- Oceans moderate temperature extremes
- Range: 0 (coldest) to 1 (hottest)

### 4. **Hydrology (Rivers)**
- Identifies high-elevation peaks as river sources
- Follows downhill gradient to sea level
- Supports branching for complex river networks
- River carving provides visual interest and biome variation

### 5. **Biomes**
- Final layer combining elevation, temperature, and moisture
- 12 distinct biome types:
  - **Water**: Deep Ocean, Shallow Ocean
  - **Coastal**: Beach
  - **Cold**: Tundra, Taiga, Snow Mountains
  - **Temperate**: Grassland, Temperate Forest, Mountain
  - **Warm**: Savanna, Desert, Tropical Forest

Biome decision tree:
```
If elevation < landThreshold - 0.1 → Deep Ocean
If elevation < landThreshold → Shallow Ocean
If elevation < landThreshold + 0.05 → Beach
If elevation > 0.7 → Mountain (or Snow Mountain if cold)
If temperature < 0.3 → Tundra
If moisture > 0.7 → Tropical Forest/Temperate Forest
If moisture > 0.5 → Savanna/Grassland
Else → Desert
```

## 🎨 Features

### Interactive Visualization
- **Multiple View Modes**:
  - Biome: Full color map with biome types
  - Elevation: Grayscale heightmap
  - Moisture: Precipitation patterns
  - Temperature: Heat distribution
  - Rivers: Hydrological features overlay

### Camera Controls
- **Zoom**: Mouse wheel or trackpad scroll
- **Pan**: Shift+drag or middle mouse button drag
- **Reset**: Press 'R' key to return to origin

### Terrain Presets
- **Large Continents**: Coarse-scale continents with varied terrain
- **Mediterranean**: Small islands and archipelagos
- **Pangea**: Single massive landmass

### Seed System
- **Deterministic Generation**: Same seed always produces identical maps
- **Random Seeding**: Generate variations with unique numerical seeds
- **Export/Import**: Save and load world data as JSON

### Customizable Parameters
- Elevation scale and octaves
- Land/sea threshold
- Moisture patterns
- River generation density
- Biome thresholds

### Export Options
- **JSON Export**: Full world data with all layers
- **PNG Export**: Visual map render as image

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ and pnpm

### Installation
```bash
pnpm install
pnpm dev
```

Open http://localhost:5173/ in your browser.

### Build for Production
```bash
pnpm build
```

## 📊 Technical Specifications

### World Size
- Default: 512×512 tiles
- Customizable via `WorldData` constructor
- Performance scales linearly with area

### Noise Implementation
- **Perlin Noise**: Multi-octave fractal generation
- **FBM (Fractional Brownian Motion)**: Combines multiple noise scales
- **Ridge Noise**: For mountainous, jagged terrain
- **Billow Noise**: Cloud-like organic patterns
- Seeded deterministic generation with configurable permutation tables

### Performance
- Single map generation: ~100-500ms (512×512)
- Typical frame rate: 60 FPS with zoom/pan
- Memory: ~4MB for 512×512 world (float32 arrays)

### Coordinate System
- Origin (0,0) at top-left
- X increases right, Y increases down
- World space maps directly to noise input
- Screen-to-world conversion handles zoom/pan

## 🛠️ API Reference

### CanvasManager

```javascript
// Rendering
canvasManager.startRenderLoop()
canvasManager.stopRenderLoop()
canvasManager.setRenderCallback(callback)

// Camera
canvasManager.resetView()
canvasManager.setLayerVisibility(name, visible)

// Coordinate conversion
canvasManager.screenToWorld(x, y) → {x, y}
canvasManager.worldToScreen(x, y) → {x, y}
```

### NoiseEngine

```javascript
const noise = new NoiseEngine(seed)

// Single-layer noise
noise.perlin(x, y) → [-1, 1]

// Multi-octave noise
noise.fbm(x, y, octaves, persistence, lacunarity) → [-1, 1]
noise.ridge(x, y, octaves, persistence, lacunarity) → [0, 1]
noise.billow(x, y, octaves, persistence, lacunarity) → [-1, 1]
```

### WorldData

```javascript
const world = new WorldData(width, height)

// Access layers
world.getElevation(x, y)
world.getMoisture(x, y)
world.getTemperature(x, y)
world.getBiome(x, y)
world.hasRiver(x, y)

// Normalize layers (0-1)
world.normalizeElevation()
world.normalizeMoisture()
world.normalizeTemperature()

// Import/Export
world.export() → object
world.import(data)
```

### MapGenerator

```javascript
const generator = new MapGenerator(worldData)

// Complete generation
generator.generate(seed)

// Presets
generator.setTerrainPreset('large-continents')

// Parameters
generator.setParameter('landThreshold', 0.4)
```

### Interface

```javascript
const ui = new Interface(canvasManager, worldData, mapGenerator)

// Rendering
ui.render(ctx)

// View modes
ui.setViewMode('biome')
ui.setViewMode('elevation')
```

## 🎓 Extending the Generator

### Adding Custom Biomes

Edit `MapGenerator.js` `determineBiome()` method:

```javascript
// Add new biome
if (specialCondition) {
  return 12; // new biome ID
}

// Update biome colors in Interface.js:
this.biomeColors = {
  12: '#color_code', // new biome
  ...
}
```

### Custom Noise Functions

Add to `NoiseEngine.js`:

```javascript
cellular(x, y, scale = 1.0) {
  // Voronoi/cellular noise implementation
}

turbulence(x, y, octaves) {
  // Turbulent, chaotic patterns
}
```

### New Generation Layers

Add to `MapGenerator.js`:

```javascript
generateCustomLayer() {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Process each tile
      this.world.setCustomLayer(x, y, value)
    }
  }
}
```

Then call from `generate()` pipeline.

## 📈 Performance Optimization

### For Large Maps (1024×1024+)
1. Reduce octave counts (6→4 for elevation)
2. Increase grid size (`Interface.gridSize = 2`)
3. Use Web Workers for generation
4. Implement LOD (level of detail)

### Memory Usage
- Current: 4 bytes × 5 layers × width × height
- 512×512: ~5MB
- 1024×1024: ~20MB
- 2048×2048: ~80MB

## 🐛 Debugging

Enable console logging:

```javascript
// In MapGenerator.js
console.time('Map Generation')
// Each step logs timing
console.timeEnd('Map Generation')
```

Check canvas layer visibility:

```javascript
canvasManager.getLayerVisibility('rivers')
```

Export world data for analysis:

```javascript
const data = worldData.export()
console.log(data.stats)
```

## 📝 License

MIT License - Feel free to use and modify

## 🎯 Future Enhancements

- [ ] Plate tectonics for landmass generation
- [ ] Erosion simulation for natural river networks
- [ ] Vegetation density layers
- [ ] Weather/climate systems
- [ ] Island generation optimization
- [ ] Multi-threaded generation with Web Workers
- [ ] VoxelJS 3D visualization
- [ ] Heightmap export for game engines
- [ ] History/undo system
- [ ] Preset saving and sharing
