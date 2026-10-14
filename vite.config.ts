import { defineConfig } from "vite";
import { gamePlugin } from "./server/vitePlugin";

export default defineConfig({
  plugins: [gamePlugin()],
  server: { host: true }, // доступно по Wi-Fi: другие игроки заходят на http://<ip хоста>:5173
});
