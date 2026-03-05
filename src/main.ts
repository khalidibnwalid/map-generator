import "./style.css";
import { CanvasManager } from "./core/CanvasManager";
import { MapGenerator } from "./game/MapGenerator";
import { Interface } from "./ui/Interface";
import renderMainApp from "./ui/components/MainApp";

renderMainApp();

// Initialize
const canvasManager = new CanvasManager("mapCanvas");
// Generate an 800x450 map logic cells size (16:9 aspect ratio)
const random = Math.floor(Math.random() * 1000000);
const generator = new MapGenerator(800, 450, random);

// Initial state: fit to screen
const fitScale = window.innerHeight / 450;
canvasManager.scale = fitScale;
canvasManager.offsetX = (window.innerWidth - 800 * canvasManager.scale) / 2;
canvasManager.offsetY = 0;

// The Interface constructor now triggers the initial generation automatically (async)
new Interface(generator, canvasManager);
