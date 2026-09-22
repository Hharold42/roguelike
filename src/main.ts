// Подключаем загрузчик glTF/GLB на будущее — сюда лягут модельки из Astra/Sketchfab
import "@babylonjs/loaders/glTF";
import { Game } from "./game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const game = new Game(canvas);
game.start();

window.addEventListener("resize", () => game.resize());
