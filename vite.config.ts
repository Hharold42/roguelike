import { defineConfig, type Plugin } from "vite";

/** /viewer → viewer.html, чтобы у страницы просмотра был короткий адрес и в dev, и в preview */
function cleanRoutes(routes: Record<string, string>): Plugin {
  const rewrite = (req: { url?: string }) => {
    const path = (req.url ?? "").split("?")[0];
    if (path in routes) req.url = routes[path] + (req.url ?? "").slice(path.length);
  };
  return {
    name: "clean-routes",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [cleanRoutes({ "/viewer": "/viewer.html" })],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        viewer: "viewer.html",
      },
    },
  },
});
