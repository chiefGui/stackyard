import { expect, test } from "bun:test";
import { resolve } from "node:path";

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const repositoryRoot = resolve(import.meta.dir, "..");

const workspaceBoundaries = {
  "apps/cli": {
    name: "@stackyard/cli",
    internalDependencies: ["@stackyard/protocol"],
  },
  "apps/server": {
    name: "@stackyard/server",
    internalDependencies: ["@stackyard/control-plane", "@stackyard/protocol"],
  },
  "apps/web": {
    name: "@stackyard/web",
    internalDependencies: ["@stackyard/protocol"],
  },
  "packages/control-plane": {
    name: "@stackyard/control-plane",
    internalDependencies: ["@stackyard/protocol"],
  },
  "packages/protocol": {
    name: "@stackyard/protocol",
    internalDependencies: [],
  },
  "packages/sdk": {
    name: "@stackyard/sdk",
    internalDependencies: ["@stackyard/protocol"],
  },
  "examples/basic": {
    name: "@stackyard/example-basic",
    internalDependencies: ["@stackyard/sdk"],
  },
} as const;

for (const [workspacePath, boundary] of Object.entries(workspaceBoundaries)) {
  test(`${boundary.name} respects its workspace boundary`, async () => {
    const manifestPath = resolve(repositoryRoot, workspacePath, "package.json");
    const manifest = (await Bun.file(manifestPath).json()) as Manifest;

    expect(manifest.name).toBe(boundary.name);

    const declaredDependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };

    const internalDependencies = Object.keys(declaredDependencies)
      .filter((name) => name.startsWith("@stackyard/"))
      .sort();

    expect(internalDependencies).toEqual([...boundary.internalDependencies].sort());
  });
}
