import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    alwaysBundle: [/^@stackyard\//, "zod"],
    onlyBundle: "zod",
    onlyImport: [],
  },
  dts: {
    generator: "oxc",
  },
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  platform: "neutral",
  target: "esnext",
});
