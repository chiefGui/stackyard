import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const port = Number(process.env.PORT ?? 5173);

export default defineConfig(({ command }) => {
  const server = {
    host: "127.0.0.1",
    port,
    strictPort: true,
  };

  if (command === "serve") {
    const controlUrl = process.env.STACKYARD_CONTROL_URL;
    if (!controlUrl) {
      throw new Error("STACKYARD_CONTROL_URL is required to run dashboard-web.");
    }
    return {
      plugins: [react()],
      server: {
        ...server,
        proxy: {
          "/api": {
            changeOrigin: true,
            target: controlUrl,
          },
        },
      },
    };
  }

  return { plugins: [react()], server };
});
