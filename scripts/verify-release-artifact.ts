import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const artifactDirectoryArgument = process.argv[2];

if (artifactDirectoryArgument === undefined) {
  throw new Error("Usage: bun scripts/verify-release-artifact.ts <artifact-directory>");
}

const artifactDirectory = resolve(repositoryRoot, artifactDirectoryArgument);
const archives = await findArchives(artifactDirectory);

if (archives.length !== 1) {
  throw new Error(
    `Expected exactly one package archive in ${artifactDirectory}, found ${archives.length}.`,
  );
}

const test = Bun.spawn({
  cmd: [process.execPath, "test", "tests/package.test.ts"],
  cwd: repositoryRoot,
  env: {
    ...stringEnvironment(process.env),
    STACKYARD_PACKAGE_TARBALL: archives[0],
  },
  stderr: "inherit",
  stdout: "inherit",
  windowsHide: true,
});

process.exit(await test.exited);

async function findArchives(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const archiveGroups = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return findArchives(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".tgz") ? [entryPath] : [];
    }),
  );

  return archiveGroups.flat();
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
