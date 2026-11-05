import "./style.css";
import { CanvasManager } from "./core/CanvasManager";
import { MapGenerator } from "./game/MapGenerator";
import { recipeFromHash } from "./game/WorldLink";
import { Interface } from "./ui/Interface";
import renderMainApp from "./ui/components/MainApp";

renderMainApp();

// Initialize
const canvasManager = new CanvasManager("mapCanvas");
// A world link (#seed=…&land=…) opens that world; otherwise a random one
const recipe = recipeFromHash(location.hash);
const generator = recipe
  ? new MapGenerator(recipe.width, recipe.height, recipe.seed)
  : new MapGenerator(800, 450, Math.floor(Math.random() * 1000000));
if (recipe) {
  generator.currentPreset = recipe.preset;
  generator.greatPowers = recipe.greatPowers;
  generator.settings = recipe.settings;
}

// Initial state: fit to screen
const W = generator.getWidth();
const H = generator.getHeight();
canvasManager.scale = window.innerHeight / H;
canvasManager.offsetX = (window.innerWidth - W * canvasManager.scale) / 2;
canvasManager.offsetY = 0;

// The Interface constructor now triggers the initial generation automatically (async)
const ui = new Interface(generator, canvasManager);

// Dev-only handle for debugging from the console
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__map = { generator, canvasManager, ui };
