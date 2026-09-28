import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The gate server serves the pages in development too, so the dev build
    // sees the same cookie and the same paths as production.
    proxy: { "/pages": "http://localhost:3000", "/login": "http://localhost:3000", "/auth": "http://localhost:3000" },
  },
});
