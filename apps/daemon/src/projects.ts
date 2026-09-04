import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  makeProjectCatalogLayer as makeControlPlaneProjectCatalogLayer,
  ProjectDefinitionLoader,
  ProjectDefinitionObserver,
  ProjectIdGenerator,
  ProjectRootResolver,
  ProjectStore,
  type ProjectDefinitionLoad,
  type ProjectRecord,
} from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  failure,
  type Diagnostic,
  type DiagnosticSink,
  type Failure,
  type Result,
} from "@stackyard/diagnostics";
import {
  discoverProject,
  loadProjectEffect,
  makeBunProjectEvaluatorLayer,
  ProjectEvaluator,
} from "@stackyard/project-loader";
import { Effect, Layer, Result as EffectResult, Schema, Scope } from "effect";

const projectStoreSchemaVersion = 1;
const projectStoreFileName = "projects.json";
const watchDebounceMilliseconds = 100;
const ProjectIdentifierSchema = Schema.Trimmed.check(Schema.isNonEmpty());
const AbsoluteProjectRootSchema = ProjectIdentifierSchema.check(
  Schema.makeFilter((root) =>
    isAbsolute(root) ? undefined : { issue: "Expected an absolute project root", path: [] },
  ),
);
const ProjectRecordSchema = Schema.Struct({
  id: ProjectIdentifierSchema,
  root: AbsoluteProjectRootSchema,
});
const ProjectFileSchema = Schema.Struct({
  projects: Schema.Array(ProjectRecordSchema),
  schemaVersion: Schema.Literal(projectStoreSchemaVersion),
}).check(
  Schema.makeFilter(({ projects }) => {
    const identifiers = new Set(projects.map(({ id }) => id));
    if (identifiers.size !== projects.length) {
      return { issue: "Expected unique project identifiers", path: ["projects"] };
    }
    const roots = new Set(projects.map(({ root }) => root));
    return roots.size === projects.length
      ? undefined
      : { issue: "Expected unique project roots", path: ["projects"] };
  }),
);

export interface ProjectCatalogLayerOptions {
  readonly dataDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly evaluatorEntrypoint: string;
}

export function makeProjectCatalogLayer(options: ProjectCatalogLayerOptions) {
  const platform = Layer.mergeAll(
    makeFileProjectStoreLayer(options.dataDirectory),
    makeFileProjectDefinitionObserverLayer(options.diagnostics),
    ProjectIdGeneratorLayer,
    ProjectRootResolverLayer,
    ProjectDefinitionLoaderLayer.pipe(
      Layer.provide(makeBunProjectEvaluatorLayer(options.evaluatorEntrypoint)),
    ),
  );
  return makeControlPlaneProjectCatalogLayer({ diagnostics: options.diagnostics }).pipe(
    Layer.provide(platform),
  );
}

export function makeFileProjectStoreLayer(directory: string): Layer.Layer<ProjectStore> {
  const storageDirectory = resolve(directory);
  const storagePath = join(storageDirectory, projectStoreFileName);
  return Layer.succeed(
    ProjectStore,
    ProjectStore.of({
      load: loadProjectRecords(storagePath),
      save: (projects) => saveProjectRecords(storageDirectory, storagePath, projects),
    }),
  );
}

const loadProjectRecords = Effect.fn("FileProjectStore.load")(function* (
  path: string,
): Effect.fn.Return<readonly ProjectRecord[], Failure> {
  const read = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: (text) => ({ success: true as const, text }),
    }),
  );
  if (!read.success) {
    if (isMissing(read.error)) {
      return Object.freeze([]);
    }
    return yield* Effect.fail(projectStorageFailure("read", path, read.error));
  }

  return yield* Effect.try({
    try: () => {
      const records = parseProjectFile(JSON.parse(read.text));
      if (!records) {
        throw new Error("The file has an invalid schema.");
      }
      return records;
    },
    catch: (error) => projectStorageFailure("parse", path, error),
  });
});

const saveProjectRecords = Effect.fn("FileProjectStore.save")(function* (
  directory: string,
  path: string,
  projects: readonly ProjectRecord[],
): Effect.fn.Return<void, Failure> {
  const temporaryPath = join(
    directory,
    `${projectStoreFileName}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const value = {
    projects: projects
      .map(({ id, root }) => ({ id, root }))
      .toSorted((left, right) => left.root.localeCompare(right.root, "en")),
    schemaVersion: projectStoreSchemaVersion,
  };
  const written = yield* Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { mode: 0o700, recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    },
    catch: (error) => error,
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: () => ({ success: true as const }),
    }),
  );
  if (written.success) {
    return undefined;
  }
  yield* Effect.promise(() => rm(temporaryPath, { force: true }).catch(() => undefined));
  return yield* Effect.fail(projectStorageFailure("write", path, written.error));
});

export function makeFileProjectDefinitionObserverLayer(
  diagnostics: DiagnosticSink,
): Layer.Layer<ProjectDefinitionObserver> {
  return Layer.succeed(
    ProjectDefinitionObserver,
    ProjectDefinitionObserver.of({
      observe: (root, onChange) => observeProjectDefinition(root, onChange, diagnostics),
    }),
  );
}

const observeProjectDefinition = Effect.fn("FileProjectDefinitionObserver.observe")(function* (
  root: string,
  onChange: () => void,
  diagnostics: DiagnosticSink,
): Effect.fn.Return<void, Failure, Scope.Scope> {
  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const observation = new FileObservation(root, onChange, diagnostics);
      const started = observation.start();
      if (!started.success) {
        return yield* Effect.fail(started);
      }
      return observation;
    }),
    (observation) => Effect.sync(() => observation.close()),
  );
});

class FileObservation {
  readonly #diagnostics: DiagnosticSink;
  readonly #onChange: () => void;
  readonly #root: string;
  readonly #watchers = new Set<FSWatcher>();
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(root: string, onChange: () => void, diagnostics: DiagnosticSink) {
    this.#diagnostics = diagnostics;
    this.#onChange = onChange;
    this.#root = root;
  }

  start(): Result<void> {
    this.#arm();
    return this.#watchers.size > 0
      ? { output: undefined, success: true }
      : failure(
          createDiagnostic({
            code: "SYD3015",
            help: "Verify that the registered project's parent directory is readable, then restart Stackyard.",
            message: "A registered project could not be watched for definition changes.",
            notes: [this.#root],
          }),
        );
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#closeWatchers();
  }

  #arm(): void {
    this.#closeWatchers();
    const rootName = basename(this.#root);
    this.#watch(dirname(this.#root), false, (name) => samePathName(name, rootName));
    this.#watch(this.#root, false, (name) => samePathName(name, "stackyard"));
    this.#watch(join(this.#root, "stackyard"), true);
  }

  #watch(path: string, recursive: boolean, relevant: (name: string) => boolean = () => true): void {
    try {
      const watcher = watch(path, { persistent: false, recursive }, (_event, fileName) => {
        if (fileName === null || relevant(fileName)) {
          this.#changed();
        }
      });
      watcher.on("error", (error) => {
        if (!this.#closed) {
          this.#diagnostics.report(watchFailure(this.#root, error));
          this.#changed();
        }
      });
      this.#watchers.add(watcher);
    } catch (error) {
      if (!isMissing(error)) {
        this.#diagnostics.report(watchFailure(this.#root, error));
      }
    }
  }

  #changed(): void {
    if (this.#closed) {
      return;
    }
    if (this.#timer) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#closed) {
        this.#arm();
        this.#onChange();
      }
    }, watchDebounceMilliseconds);
  }

  #closeWatchers(): void {
    for (const watcher of this.#watchers) {
      watcher.close();
    }
    this.#watchers.clear();
  }
}

const ProjectIdGeneratorLayer: Layer.Layer<ProjectIdGenerator> = Layer.succeed(
  ProjectIdGenerator,
  ProjectIdGenerator.of({ next: Effect.sync(() => crypto.randomUUID()) }),
);

const ProjectRootResolverLayer: Layer.Layer<ProjectRootResolver> = Layer.succeed(
  ProjectRootResolver,
  ProjectRootResolver.of({
    canonicalize: Effect.fn("ProjectRootResolver.canonicalize")(function* (path: string) {
      const discovered = yield* discoverProject(path, process.cwd());
      return yield* Effect.tryPromise({
        try: () => realpath(discovered.root),
        catch: (error) =>
          failure(
            createDiagnostic({
              code: "SYD2006",
              help: "Verify that the project path exists and is readable, then retry.",
              message: "The project root could not be resolved.",
              notes: [describeError(error)],
            }),
          ),
      });
    }),
  }),
);

const ProjectDefinitionLoaderLayer: Layer.Layer<ProjectDefinitionLoader, never, ProjectEvaluator> =
  Layer.effect(
    ProjectDefinitionLoader,
    Effect.gen(function* () {
      const evaluator = yield* ProjectEvaluator;
      return ProjectDefinitionLoader.of({
        load: (root) =>
          loadProjectDefinition(root).pipe(Effect.provideService(ProjectEvaluator, evaluator)),
      });
    }),
  );

const loadProjectDefinition = Effect.fn("ProjectDefinitionLoader.load")(function* (
  root: string,
): Effect.fn.Return<ProjectDefinitionLoad, never, ProjectEvaluator> {
  const loaded = yield* loadProjectEffect({ currentDirectory: root, path: root }).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: (project) => ({ project, success: true as const }),
    }),
  );
  if (loaded.success) {
    return { kind: "valid", spec: loaded.project.spec };
  }
  return {
    diagnostics: loaded.error.diagnostics,
    kind: loaded.error.diagnostics.some(({ code }) => code === "SYD2000") ? "missing" : "invalid",
  };
});

function parseProjectFile(input: unknown): readonly ProjectRecord[] | undefined {
  const parsed = Schema.decodeUnknownResult(ProjectFileSchema, {
    onExcessProperty: "error",
  })(input);
  return EffectResult.isSuccess(parsed)
    ? Object.freeze(parsed.success.projects.map(({ id, root }) => Object.freeze({ id, root })))
    : undefined;
}

function projectStorageFailure(
  operation: "parse" | "read" | "write",
  path: string,
  error: unknown,
): Failure {
  const action = operation === "parse" ? "is invalid" : `could not be ${operation}`;
  return failure(
    createDiagnostic({
      code: "SYD3014",
      help:
        operation === "parse"
          ? "Repair or remove the project file, then restart Stackyard. Removing it forgets every project."
          : "Verify that the Stackyard data directory is writable, then retry.",
      message: `The Stackyard project catalog ${action}.`,
      notes: [path, describeError(error)],
    }),
  );
}

function watchFailure(root: string, error: unknown): Diagnostic {
  return createDiagnostic({
    code: "SYD3015",
    help: "Verify that the project is readable. Stackyard will retry when its directory changes.",
    message: "A project watcher failed.",
    notes: [root, describeError(error)],
    severity: "warning",
  });
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function samePathName(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, "en", { sensitivity: "base" }) === 0
    : left === right;
}
