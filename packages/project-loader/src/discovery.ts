import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { createDiagnostic, failure, success, type Result } from "@stackyard/diagnostics";

export interface ProjectLocation {
  readonly entrypoint: string;
  readonly root: string;
}

export async function discoverProject(
  input: string | undefined,
  currentDirectory: string,
): Promise<Result<ProjectLocation>> {
  try {
    if (input) {
      return await discoverExplicitProject(resolve(currentDirectory, input));
    }

    const startingDirectory = resolve(currentDirectory);
    let directory = startingDirectory;

    while (true) {
      // Ancestors must be checked in order so the nearest project wins.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const location = await locationFromDirectory(directory);
      if (location) {
        return success(location);
      }

      const parent = dirname(directory);
      if (parent === directory || directory === parse(directory).root) {
        break;
      }

      directory = parent;
    }

    return notFound(startingDirectory);
  } catch (error) {
    return failure(
      createDiagnostic({
        code: "SYD2006",
        help: "Verify that the project path exists and is readable, then retry.",
        message: "Project discovery failed.",
        ...(error instanceof Error && error.message.trim().length > 0
          ? { notes: [error.message] }
          : {}),
      }),
    );
  }
}

async function discoverExplicitProject(path: string): Promise<Result<ProjectLocation>> {
  const pathStat = await statIfExists(path);

  if (pathStat?.isFile()) {
    return success({
      entrypoint: path,
      root: dirname(dirname(path)),
    });
  }

  if (pathStat?.isDirectory()) {
    const location = await locationFromDirectory(path);
    if (location) {
      return success(location);
    }
  }

  return notFound(path);
}

async function locationFromDirectory(root: string): Promise<ProjectLocation | undefined> {
  const entrypoint = join(root, "stackyard", "main.ts");
  const entrypointStat = await statIfExists(entrypoint);

  return entrypointStat?.isFile() ? { entrypoint, root } : undefined;
}

async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isFileSystemError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }

    throw error;
  }
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function notFound(path: string): Result<ProjectLocation> {
  return failure(
    createDiagnostic({
      code: "SYD2000",
      help: "Create stackyard/main.ts or pass the path to an existing Stackyard project.",
      message: `No stackyard/main.ts was found from '${path}'.`,
    }),
  );
}
