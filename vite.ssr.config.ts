/**
 * Separate Vite config for SSR pre-render build (LPS-864).
 *
 * Intentionally minimal — no MPA plugin, no SEO injector, no lovable-tagger.
 * Only the React SWC transform and the @/ alias are needed to compile
 * entry-server.tsx and all transitively-imported page/section components.
 *
 * Output: dist-ssr/entry-server.js (Node.js ESM, never uploaded to GCS)
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    ssr: true,
    outDir: "dist-ssr",
    rollupOptions: {
      input: "./src/entry-server.tsx",
      output: {
        format: "esm",
      },
    },
  },
  // Suppress Rollup/Vite noise during SSR build — not user-facing
  logLevel: "warn",
});
