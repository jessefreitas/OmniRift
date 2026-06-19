import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone marketing site for OmniRift. Served on a different port than the
// desktop dev server (5173) so both can run side by side.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 5180,
    strictPort: true,
    host: true,
  },
  build: {
    target: "es2022",
  },
});
