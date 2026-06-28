import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Use an explicit IPv4 address so the proxy never lands on an IPv6-only
// resolution of "localhost" (which caused the dev server to be unreachable
// over 127.0.0.1 and the UI to load empty).
const API_TARGET = "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    host: true, // bind all interfaces (IPv4 + IPv6), not just [::1]
    proxy: {
      "/api": API_TARGET,
      "/uploads": API_TARGET,
    },
  },
});
