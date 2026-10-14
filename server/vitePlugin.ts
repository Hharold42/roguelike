/**
 * Плагин Vite: поднимает игровой сервер (GameServer) на том же http-порту, что
 * и dev/preview, по пути /ws. Одна команда `npm run dev` — и клиент, и сервер;
 * друзья в локальной сети заходят по адресу хоста (vite запускается с --host).
 *
 * Сервер импортируется напрямую (конфиг Vite собирается вместе с импортами),
 * правки server/ или src/shared/ перезапускают dev-сервер сами.
 */

import type { Plugin } from "vite";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { GameServer } from "./gameServer";

const WS_PATH = "/ws";

function mount(httpServer: Server | null): void {
  if (!httpServer) return;
  const seedEnv = process.env.GAME_SEED;
  const game = new GameServer(seedEnv ? Number(seedEnv) : undefined);
  const wss = new WebSocketServer({ noServer: true });
  game.attach(wss);
  httpServer.on("upgrade", (req, socket, head) => {
    // Остальные upgrade (HMR самого Vite) не трогаем
    if ((req.url ?? "").split("?")[0] !== WS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  httpServer.on("close", () => {
    game.stop();
    wss.close();
  });
  console.info(`[game] сервер PvP запущен, сид мира ${game.seed}, ws ${WS_PATH}`);
}

export function gamePlugin(): Plugin {
  return {
    name: "game-server",
    configureServer(server) {
      mount(server.httpServer as Server | null);
    },
    configurePreviewServer(server) {
      mount(server.httpServer as Server | null);
    },
  };
}
