import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  ProjectCatalog,
  type ProjectDefinitionLoad,
  type ProjectDefinitionObservation,
  type ProjectDefinitionObserver,
  type ProjectRecord,
  type ProjectStore,
} from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  failure,
  success,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";
import { discoverProject, loadProject } from "@stackyard/project-loader";

const projectStoreSchemaVersion = 1;
const projectStoreFileName = "projects.json";
const watchDebounceMilliseconds = 100;

export interface OpenProjectCatalogOptions {
  readonly dataDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly evaluatorEntrypoint: string;
}

export function openProjectCatalog(
  options: OpenProjectCatalogOptions,
): Promise<Result<ProjectCatalog>> {
  return ProjectCatalog.open({
    canonicalize: (path) => canonicalProjectRoot(path),
    createId: () => crypto.randomUUID(),
    diagnostics: options.diagnostics,
    loadDefinition: (root) => loadProjectDefinition(root, options.evaluatorEntrypoint),
    observer: new FileProjectDefinitionObserver(options.diagnostics),
    store: new FileProjectStore(options.dataDirectory),
  });
}

export class FileProjectStore implements ProjectStore {
  readonly #directory: string;
  readonly #path: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
    this.#path = join(this.#directory, projectStoreFileName);
  }

  async load(): Promise<Result<readonly ProjectRecord[]>> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      return isMissing(error) ? success([]) : projectStorageFailure("read", this.#path, error);
    }

    try {
      const parsed: unknown = JSON.parse(text);
      const records = parseProjectFile(parsed);
      return records
        ? success(records)
        : projectStorageFailure("parse", this.#path, new Error("The file has an invalid schema."));
    } catch (error) {
      return projectStorageFailure("parse", this.#path, error);
    }
  }

  async save(projects: readonly ProjectRecord[]): Promise<Result<void>> {
    const temporaryPath = join(
      this.#directory,
      `${projectStoreFileName}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    const value = {
      projects: projects
        .map(({ id, root }) => ({ id, root }))
        .toSorted((left, right) => left.root.localeCompare(right.root, "en")),
      schemaVersion: projectStoreSchemaVersion,
    };

    try {
      await mkdir(this.#directory, { mode: 0o700, recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#path);
      return success(undefined);
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // The original storage failure is more useful than temporary-file cleanup failure.
      }
      return projectStorageFailure("write", this.#path, error);
    }
  }
}

export class FileProjectDefinitionObserver implements ProjectDefinitionObserver {
  constructor(private readonly diagnostics: DiagnosticSink) {}

  observe(root: string, onChange: () => void): Result<ProjectDefinitionObservation> {
    const observation = new FileObservation(root, onChange, this.diagnostics);
    const started = observation.start();
    return started.success ? success(observation) : started;
  }
}

class FileObservation implements ProjectDefinitionObservation {
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
      ? success(undefined)
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
      if (this.#closed) {
        return;
      }
      this.#arm();
      this.#onChange();
    }, watchDebounceMilliseconds);
  }

  #closeWatchers(): void {
    for (const watcher of this.#watchers) {
      watcher.close();
    }
    this.#watchers.clear();
  }
}

async function canonicalProjectRoot(path: string): Promise<Result<string>> {
  const discovered = await discoverProject(path, process.cwd());
  if (!discovered.success) {
    return discovered;
  }

  try {
    return success(await realpath(discovered.output.root));
  } catch (error) {
    return failure(
      createDiagnostic({
        code: "SYD2006",
        help: "Verify that the project path exists and is readable, then retry.",
        message: "The project root could not be resolved.",
        notes: [describeError(error)],
      }),
    );
  }
}

async function loadProjectDefinition(
  root: string,
  evaluatorEntrypoint: string,
): Promise<ProjectDefinitionLoad> {
  const loaded = await loadProject({ currentDirectory: root, evaluatorEntrypoint, path: root });
  if (loaded.result.success) {
    return { kind: "valid", spec: loaded.result.output.spec };
  }

  return {
    diagnostics: loaded.result.diagnostics,
    kind: loaded.result.diagnostics.some(({ code }) => code === "SYD2000") ? "missing" : "invalid",
  };
}

function parseProjectFile(input: unknown): readonly ProjectRecord[] | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["projects", "schemaVersion"]) ||
    input.schemaVersion !== projectStoreSchemaVersion ||
    !Array.isArray(input.projects)
  ) {
    return undefined;
  }

  const identifiers = new Set<string>();
  const roots = new Set<string>();
  const records: ProjectRecord[] = [];
  for (const value of input.projects) {
    if (
      !isPlainObject(value) ||
      !hasExactKeys(value, ["id", "root"]) ||
      !isNonEmptyString(value.id) ||
      !isNonEmptyString(value.root) ||
      !isAbsolute(value.root) ||
      identifiers.has(value.id) ||
      roots.has(value.root)
    ) {
      return undefined;
    }
    identifiers.add(value.id);
    roots.add(value.root);
    records.push(Object.freeze({ id: value.id, root: value.root }));
  }
  return Object.freeze(records);
}

function projectStorageFailure<T>(
  operation: "parse" | "read" | "write",
  path: string,
  error: unknown,
): Result<T> {
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

function watchFailure(root: string, error: unknown) {
  return createDiagnostic({
    code: "SYD3015",
    help: "Verify that the project is readable. Stackyard will retry when its directory changes.",
    message: "A project watcher failed.",
    notes: [root, describeError(error)],
    severity: "warning",
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.length === required.length;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
