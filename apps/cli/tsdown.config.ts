import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    alwaysBundle: [/^@stackyard\//, "zod"],
    onlyBundle: false,
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
