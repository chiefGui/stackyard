import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileProjectDefinitionObserver, FileProjectStore } from "../apps/daemon/src/projects.ts";

test("the project store persists and replaces its complete snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-projects-"));
  const store = new FileProjectStore(directory);
  try {
    const empty = await store.load();
    expect(empty.success).toBeTrue();
    if (!empty.success) {
      throw new Error("Expected an empty project store.");
    }
    expect(empty.output).toEqual([]);
    expect(
      (
        await store.save([
          { id: "two", root: "/zeta" },
          { id: "one", root: "/alpha" },
        ])
      ).success,
    ).toBeTrue();
    const firstLoad = await store.load();
    if (!firstLoad.success) {
      throw new Error("Expected persisted projects.");
    }
    expect(firstLoad.output).toEqual([
      { id: "one", root: "/alpha" },
      { id: "two", root: "/zeta" },
    ]);

    expect((await store.save([{ id: "two", root: "/zeta" }])).success).toBeTrue();
    const secondLoad = await store.load();
    if (!secondLoad.success) {
      throw new Error("Expected the replaced project snapshot.");
    }
    expect(secondLoad.output).toEqual([{ id: "two", root: "/zeta" }]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the project store refuses corrupt persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-projects-corrupt-"));
  try {
    await writeFile(join(directory, "projects.json"), "{", "utf8");

    const loaded = await new FileProjectStore(directory).load();

    expect(loaded.success).toBeFalse();
    if (!loaded.success) {
      expect(loaded.diagnostics[0].code).toBe("SYD3014");
      expect(loaded.diagnostics[0].help).toContain("Removing it forgets every project");
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the project definition observer coalesces definition changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackyard-observer-"));
  const definitionDirectory = join(root, "stackyard");
  await mkdir(definitionDirectory);
  await writeFile(join(definitionDirectory, "main.ts"), "export {};\n", "utf8");
  let changes = 0;
  let changed!: () => void;
  const observedChange = new Promise<void>((resolveChange) => {
    changed = resolveChange;
  });
  const observer = new FileProjectDefinitionObserver({ report() {} });
  const observed = observer.observe(root, () => {
    changes += 1;
    changed();
  });
  if (!observed.success) {
    throw new Error("Expected the definition observer to start.");
  }

  try {
    await writeFile(join(definitionDirectory, "main.ts"), "export const changed = true;\n", "utf8");
    await Promise.race([
      observedChange,
      Bun.sleep(2_000).then(() => {
        throw new Error("Timed out waiting for a definition change.");
      }),
    ]);
    await Bun.sleep(150);
    expect(changes).toBe(1);
  } finally {
    observed.output.close();
    await rm(root, { force: true, recursive: true });
  }
});
