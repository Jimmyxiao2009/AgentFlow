import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // Exclude Rust build output to avoid EBUSY on Windows when cargo writes DLLs
      ignored: ["**/src-tauri/target/**", "**/.agentflow-data/**"],
    },
  },
  build: { target: "es2022", sourcemap: true },
});
