import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    emptyOutDir: true,
    outDir: "dist/client",
    rollupOptions: {
      input: "src/client/main.tsx",
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith(".css"))) {
            return "assets/app.css";
          }
          return "assets/[name][extname]";
        },
        chunkFileNames: "assets/[name].js",
        entryFileNames: "assets/app.js",
      },
    },
  },
});
