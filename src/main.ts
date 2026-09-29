// Пиксельный шрифт UI (локально, без CDN): латиница + кириллица
import "@fontsource/press-start-2p/latin-400.css";
import "@fontsource/press-start-2p/cyrillic-400.css";
import { Game } from "./game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const game = new Game(canvas);
game.start();

window.addEventListener("resize", () => game.resize());
