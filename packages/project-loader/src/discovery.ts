import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { createDiagnostic, failure, type Failure } from "@stackyard/diagnostics";
import { Effect } from "effect";

export interface ProjectLocation {
  readonly entrypoint: string;
  readonly root: string;
}

export const discoverProject = Effect.fn("discoverProject")(function* (
  input: string | undefined,
  currentDirectory: string,
): Effect.fn.Return<ProjectLocation, Failure> {
  return yield* input
    ? discoverExplicitProject(resolve(currentDirectory, input))
    : discoverFromAncestors(resolve(currentDirectory));
});

const discoverFromAncestors = Effect.fn("discoverFromAncestors")(function* (
  startingDirectory: string,
) {
  let directory = startingDirectory;
  while (true) {
    const location = yield* locationFromDirectory(directory);
    if (location) {
      return location;
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) {
      return yield* Effect.fail(notFound(startingDirectory));
    }
    directory = parent;
  }
});

const discoverExplicitProject = Effect.fn("discoverExplicitProject")(function* (path: string) {
  const pathStat = yield* statIfExists(path);
  if (pathStat?.isFile()) {
    return { entrypoint: path, root: dirname(dirname(path)) };
  }
  if (pathStat?.isDirectory()) {
    const location = yield* locationFromDirectory(path);
    if (location) {
      return location;
    }
  }
  return yield* Effect.fail(notFound(path));
});

const locationFromDirectory = Effect.fn("locationFromDirectory")(function* (root: string) {
  const entrypoint = join(root, "stackyard", "main.ts");
  const entrypointStat = yield* statIfExists(entrypoint);
  return entrypointStat?.isFile() ? { entrypoint, root } : undefined;
});

const statIfExists = Effect.fn("statIfExists")(
  (path: string): Effect.Effect<Stats | undefined, Failure> =>
    Effect.tryPromise({
      try: () => stat(path),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        isFileSystemError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")
          ? Effect.succeed(undefined)
          : Effect.fail(
              failure(
                createDiagnostic({
                  code: "SYD2006",
                  help: "Verify that the project path exists and is readable, then retry.",
                  message: "Project discovery failed.",
                  ...(error instanceof Error && error.message.trim().length > 0
                    ? { notes: [error.message] }
                    : {}),
                }),
              ),
            ),
      ),
    ),
);

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function notFound(path: string): Failure {
  return failure(
    createDiagnostic({
      code: "SYD2000",
      help: "Create stackyard/main.ts or pass the path to an existing Stackyard project.",
      message: `No stackyard/main.ts was found from '${path}'.`,
    }),
  );
}
