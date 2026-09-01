import { fileURLToPath } from "node:url";

import stylex from "@stylexjs/unplugin/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const port = Number(process.env.PORT ?? 5173);
const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ command }) => {
  const plugins = [
    tanstackRouter({ autoCodeSplitting: true, target: "react" }),
    stylex({
      sxPropName: false,
      unstable_moduleResolution: { rootDir: rootDirectory, type: "commonJS" },
      useCSSLayers: { before: ["reset"], prefix: "stylex" },
    }),
    react(),
  ];
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
      plugins,
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

  return { plugins, server };
});
