import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const port = Number(process.env.PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
  },
});
