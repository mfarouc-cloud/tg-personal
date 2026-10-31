import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";

// teleproto / GramJS is a Node-oriented MTProto library. To run it in the
// browser we polyfill Buffer/process/crypto and expose `global`.
export default defineConfig({
  define: {
    global: "globalThis",
  },
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png", "favicon.svg"],
      manifest: {
        name: "HBOLT",
        short_name: "HBOLT",
        description: "Personal Telegram client with power features",
        lang: "ar",
        dir: "rtl",
        theme_color: "#05080D",
        background_color: "#05080D",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: "index.html",
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: "es2020",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5173 },
});
