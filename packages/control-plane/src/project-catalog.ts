import {
  createDiagnostic,
  failure,
  success,
  type DiagnosticSink,
  type NonEmptyDiagnostics,
  type Result,
} from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";

export interface ProjectRecord {
  readonly id: string;
  readonly root: string;
}

export type ProjectDefinitionLoad =
  | { readonly kind: "invalid" | "missing"; readonly diagnostics: NonEmptyDiagnostics }
  | { readonly kind: "valid"; readonly spec: ProjectSpec };

export type ProjectDefinitionState =
  | {
      readonly kind: "invalid" | "missing";
      readonly diagnostics: NonEmptyDiagnostics;
      readonly lastValidSpec?: ProjectSpec;
    }
  | { readonly kind: "loading" }
  | { readonly kind: "valid"; readonly spec: ProjectSpec };

export interface CatalogProject {
  readonly definition: ProjectDefinitionState;
  readonly id: string;
  readonly revision: number;
  readonly root: string;
}

export interface ProjectStore {
  load(): Promise<Result<readonly ProjectRecord[]>>;
  save(projects: readonly ProjectRecord[]): Promise<Result<void>>;
}

export interface ProjectDefinitionObservation {
  close(): void;
}

export interface ProjectDefinitionObserver {
  observe(root: string, onChange: () => void): Result<ProjectDefinitionObservation>;
}

export interface ProjectCatalogOptions {
  readonly diagnostics: DiagnosticSink;
  readonly observer: ProjectDefinitionObserver;
  readonly store: ProjectStore;
  readonly evaluationConcurrency?: number;
  readonly canonicalize: (path: string) => Promise<Result<string>>;
  readonly createId: () => string;
  readonly loadDefinition: (root: string) => Promise<ProjectDefinitionLoad>;
}

interface CatalogEntry extends ProjectRecord {
  definition: ProjectDefinitionState;
  observation?: ProjectDefinitionObservation;
  refreshAgain: boolean;
  refreshTask?: Promise<void>;
  revision: number;
}

const defaultEvaluationConcurrency = 4;

export class ProjectCatalog {
  readonly #canonicalize: ProjectCatalogOptions["canonicalize"];
  readonly #createId: ProjectCatalogOptions["createId"];
  readonly #diagnostics: DiagnosticSink;
  readonly #entries = new Map<string, CatalogEntry>();
  readonly #evaluationConcurrency: number;
  readonly #loadDefinition: ProjectCatalogOptions["loadDefinition"];
  readonly #observer: ProjectDefinitionObserver;
  readonly #roots = new Map<string, CatalogEntry>();
  readonly #store: ProjectStore;
  readonly #waitingForEvaluation: (() => void)[] = [];
  #activeEvaluations = 0;
  #closed = false;
  #mutationQueue: Promise<void> = Promise.resolve();

  private constructor(options: ProjectCatalogOptions) {
    this.#canonicalize = options.canonicalize;
    this.#createId = options.createId;
    this.#diagnostics = options.diagnostics;
    this.#evaluationConcurrency = options.evaluationConcurrency ?? defaultEvaluationConcurrency;
    this.#loadDefinition = options.loadDefinition;
    this.#observer = options.observer;
    this.#store = options.store;

    if (!Number.isSafeInteger(this.#evaluationConcurrency) || this.#evaluationConcurrency < 1) {
      throw new TypeError("Project definition evaluation concurrency must be a positive integer.");
    }
  }

  static async open(options: ProjectCatalogOptions): Promise<Result<ProjectCatalog>> {
    const stored = await options.store.load();
    if (!stored.success) {
      return stored;
    }

    const catalog = new ProjectCatalog(options);
    for (const project of stored.output) {
      const entry: CatalogEntry = {
        ...project,
        definition: { kind: "loading" },
        refreshAgain: false,
        revision: 0,
      };
      catalog.#entries.set(entry.id, entry);
      catalog.#roots.set(entry.root, entry);
      catalog.#observe(entry);
      void catalog.#refresh(entry).catch((error: unknown) => catalog.#reportRefreshError(error));
    }
    return success(catalog);
  }

  list(): readonly CatalogProject[] {
    return Object.freeze(
      [...this.#entries.values()]
        .map((entry) => snapshot(entry))
        .toSorted((left, right) => compareProjects(left, right)),
    );
  }

  async refreshByRoot(root: string): Promise<Result<CatalogProject>> {
    const entry = this.#roots.get(root);
    if (!entry) {
      return failure(
        createDiagnostic({
          code: "SYD4100",
          help: "Run 'stackyard add .' from this project, then retry.",
          message: "This project has not been added to Stackyard.",
          notes: [root],
        }),
      );
    }
    await this.#refresh(entry);
    return success(snapshot(entry));
  }

  resolve(target: string): Result<CatalogProject> {
    const resolved = this.#resolve(target);
    return resolved.success ? success(snapshot(resolved.output)) : resolved;
  }

  add(path: string): Promise<Result<CatalogProject>> {
    return this.#mutate(async () => {
      const canonical = await this.#canonicalize(path);
      if (!canonical.success) {
        return canonical;
      }

      const existing = this.#roots.get(canonical.output);
      if (existing) {
        await this.#refresh(existing);
        return success(snapshot(existing));
      }

      const id = this.#createId();
      if (this.#entries.has(id)) {
        return failure(
          createDiagnostic({
            code: "SYD4103",
            help: "Retry the command to generate another project identifier.",
            message: "The generated project identifier already belongs to another project.",
          }),
        );
      }

      const record = Object.freeze({ id, root: canonical.output });
      const saved = await this.#store.save([...this.#records(), record]);
      if (!saved.success) {
        return saved;
      }

      const entry: CatalogEntry = {
        ...record,
        definition: { kind: "loading" },
        refreshAgain: false,
        revision: 0,
      };
      this.#entries.set(entry.id, entry);
      this.#roots.set(entry.root, entry);
      this.#observe(entry);
      await this.#refresh(entry);
      return success(snapshot(entry));
    });
  }

  remove(target: string): Promise<Result<CatalogProject>> {
    return this.#mutate(async () => {
      const resolved = this.#resolve(target);
      if (!resolved.success) {
        return resolved;
      }
      const entry = resolved.output;
      const remaining = this.#records().filter(({ id }) => id !== entry.id);
      const saved = await this.#store.save(remaining);
      if (!saved.success) {
        return saved;
      }

      this.#forget(entry);
      return success(snapshot(entry));
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#mutationQueue.catch(() => undefined);
    const refreshes: Promise<void>[] = [];
    for (const entry of this.#entries.values()) {
      entry.observation?.close();
      delete entry.observation;
      if (entry.refreshTask) {
        refreshes.push(entry.refreshTask);
      }
    }
    await Promise.allSettled(refreshes);
  }

  #mutate<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#closed) {
      return Promise.resolve(
        failure(
          createDiagnostic({
            code: "SYD4105",
            help: "Open the project catalog again before changing projects.",
            message: "The project catalog is closed.",
          }),
        ),
      );
    }

    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(noop, noop);
    return result;
  }

  #records(): ProjectRecord[] {
    return [...this.#entries.values()]
      .map(({ id, root }) => Object.freeze({ id, root }))
      .toSorted((left, right) => left.root.localeCompare(right.root, "en"));
  }

  #resolve(target: string): Result<CatalogEntry> {
    const byId = this.#entries.get(target);
    if (byId) {
      return success(byId);
    }

    const byRoot = this.#roots.get(target);
    if (byRoot) {
      return success(byRoot);
    }

    const byName = [...this.#entries.values()].filter(
      (entry) => definitionName(entry.definition) === target,
    );
    if (byName.length === 1 && byName[0]) {
      return success(byName[0]);
    }
    if (byName.length > 1) {
      return failure(
        createDiagnostic({
          code: "SYD4101",
          help: "Choose the project by its identifier instead.",
          message: `More than one project is named '${target}'.`,
          notes: byName.map(({ id, root }) => `${id}: ${root}`),
        }),
      );
    }

    return failure(
      createDiagnostic({
        code: "SYD4100",
        help: "Run 'stackyard list' to list projects, or 'stackyard add .' to add this one.",
        message: `No project matches '${target}'.`,
      }),
    );
  }

  #observe(entry: CatalogEntry): void {
    const observed = this.#observer.observe(entry.root, () => {
      if (this.#entries.get(entry.id) === entry) {
        void this.#refresh(entry).catch((error: unknown) => this.#reportRefreshError(error));
      }
    });
    if (!observed.success) {
      for (const diagnostic of observed.diagnostics) {
        this.#diagnostics.report(diagnostic);
      }
      return;
    }
    entry.observation = observed.output;
  }

  async #refresh(entry: CatalogEntry): Promise<void> {
    if (this.#closed || this.#entries.get(entry.id) !== entry) {
      return;
    }
    if (entry.refreshTask) {
      entry.refreshAgain = true;
      await entry.refreshTask;
      return;
    }

    entry.refreshTask = this.#refreshLoop(entry).finally(() => {
      delete entry.refreshTask;
    });
    await entry.refreshTask;
  }

  async #refreshLoop(entry: CatalogEntry): Promise<void> {
    do {
      entry.refreshAgain = false;
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Refreshes for one project must publish in order. */
      const loaded = await this.#evaluate(entry.root);
      if (this.#closed || this.#entries.get(entry.id) !== entry) {
        return;
      }

      if (loaded.kind === "valid") {
        const previous = lastValidDefinition(entry.definition);
        if (!previous || !sameProjectSpec(previous, loaded.spec)) {
          entry.revision += 1;
        }
        entry.definition = Object.freeze({ kind: "valid", spec: loaded.spec });
        continue;
      }

      const lastValidSpec = lastValidDefinition(entry.definition);
      entry.definition = Object.freeze({
        diagnostics: loaded.diagnostics,
        kind: loaded.kind,
        ...(lastValidSpec ? { lastValidSpec } : {}),
      });
    } while (entry.refreshAgain);
  }

  async #evaluate(root: string): Promise<ProjectDefinitionLoad> {
    await this.#acquireEvaluationSlot();
    try {
      return await this.#loadDefinition(root);
    } finally {
      this.#releaseEvaluationSlot();
    }
  }

  async #acquireEvaluationSlot(): Promise<void> {
    if (this.#activeEvaluations < this.#evaluationConcurrency) {
      this.#activeEvaluations += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waitingForEvaluation.push(resolve));
    this.#activeEvaluations += 1;
  }

  #releaseEvaluationSlot(): void {
    this.#activeEvaluations -= 1;
    this.#waitingForEvaluation.shift()?.();
  }

  #forget(entry: CatalogEntry): void {
    entry.observation?.close();
    this.#entries.delete(entry.id);
    if (this.#roots.get(entry.root) === entry) {
      this.#roots.delete(entry.root);
    }
  }

  #reportRefreshError(error: unknown): void {
    this.#diagnostics.report(
      createDiagnostic({
        code: "SYD4104",
        help: "Retry the project change. If the problem persists, restart Stackyard.",
        message: "A project could not be refreshed.",
        notes: [error instanceof Error ? error.message : String(error)],
      }),
    );
  }
}

function snapshot(entry: CatalogEntry): CatalogProject {
  return Object.freeze({
    definition: entry.definition,
    id: entry.id,
    revision: entry.revision,
    root: entry.root,
  });
}

function compareProjects(left: CatalogProject, right: CatalogProject): number {
  const leftName = definitionName(left.definition) ?? left.root;
  const rightName = definitionName(right.definition) ?? right.root;
  return leftName.localeCompare(rightName, "en") || left.root.localeCompare(right.root, "en");
}

function definitionName(definition: ProjectDefinitionState): string | undefined {
  return definitionSpec(definition)?.name;
}

export function definitionSpec(definition: ProjectDefinitionState): ProjectSpec | undefined {
  if (definition.kind === "valid") {
    return definition.spec;
  }
  if (definition.kind === "invalid" || definition.kind === "missing") {
    return definition.lastValidSpec;
  }
  return undefined;
}

function lastValidDefinition(definition: ProjectDefinitionState): ProjectSpec | undefined {
  return definitionSpec(definition);
}

function sameProjectSpec(left: ProjectSpec, right: ProjectSpec): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function noop(): void {}
