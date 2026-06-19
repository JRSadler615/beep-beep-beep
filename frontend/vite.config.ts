import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    // Proxy /api to the FastAPI backend during local dev so the SPA can use
    // same-origin relative paths. Set VITE_API_URL to override in production.
    // PROD HOSTNAME: this proxy is dev-only (vite dev server). Production builds
    // ignore it — the deployed SPA reaches the API via VITE_API_URL instead.
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY || "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
})
