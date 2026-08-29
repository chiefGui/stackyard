import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import type { Result } from "@stackyard/protocol";

export interface ProjectLocation {
  readonly entrypoint: string;
  readonly root: string;
}

export async function discoverProject(input: string | undefined): Promise<Result<ProjectLocation>> {
  try {
    if (input) {
      return await discoverExplicitProject(resolve(input));
    }

    let directory = resolve(process.cwd());

    while (true) {
      const location = await locationFromDirectory(directory);
      if (location) {
        return { output: location, success: true };
      }

      const parent = dirname(directory);
      if (parent === directory || directory === parse(directory).root) {
        break;
      }

      directory = parent;
    }

    return notFound(resolve(process.cwd()));
  } catch (error) {
    return {
      diagnostics: [
        {
          code: "SYD2006",
          message:
            error instanceof Error
              ? error.message
              : "Project discovery failed with an unknown error.",
          path: [],
        },
      ],
      success: false,
    };
  }
}

async function discoverExplicitProject(path: string): Promise<Result<ProjectLocation>> {
  const pathStat = await statIfExists(path);

  if (pathStat?.isFile()) {
    return {
      output: {
        entrypoint: path,
        root: dirname(dirname(path)),
      },
      success: true,
    };
  }

  if (pathStat?.isDirectory()) {
    const location = await locationFromDirectory(path);
    if (location) {
      return { output: location, success: true };
    }
  }

  return notFound(path);
}

async function locationFromDirectory(root: string): Promise<ProjectLocation | undefined> {
  const entrypoint = join(root, "stackyard", "main.ts");
  const entrypointStat = await statIfExists(entrypoint);

  if (!entrypointStat?.isFile()) {
    return undefined;
  }

  return { entrypoint, root };
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
  return {
    diagnostics: [
      {
        code: "SYD2000",
        message: `No stackyard/main.ts was found from '${path}'.`,
        path: [],
      },
    ],
    success: false,
  };
}
