import {
  createDiagnostic,
  failure,
  success,
  type DiagnosticSink,
  type NonEmptyDiagnostics,
  type Result,
} from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";

export interface ProjectRegistrationRecord {
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

export interface ProjectRegistration {
  readonly definition: ProjectDefinitionState;
  readonly id: string;
  readonly root: string;
}

export interface ProjectRegistrationStore {
  load(): Promise<Result<readonly ProjectRegistrationRecord[]>>;
  save(registrations: readonly ProjectRegistrationRecord[]): Promise<Result<void>>;
}

export interface ProjectDefinitionObservation {
  close(): void;
}

export interface ProjectDefinitionObserver {
  observe(root: string, onChange: () => void): Result<ProjectDefinitionObservation>;
}

export interface ProjectRegistryOptions {
  readonly diagnostics: DiagnosticSink;
  readonly observer: ProjectDefinitionObserver;
  readonly store: ProjectRegistrationStore;
  readonly evaluationConcurrency?: number;
  readonly canonicalize: (path: string) => Promise<Result<string>>;
  readonly createId: () => string;
  readonly isActive: (root: string) => boolean;
  readonly loadDefinition: (root: string) => Promise<ProjectDefinitionLoad>;
}

interface RegistryEntry extends ProjectRegistrationRecord {
  definition: ProjectDefinitionState;
  observation?: ProjectDefinitionObservation;
  refreshAgain: boolean;
  refreshTask?: Promise<void>;
}

const defaultEvaluationConcurrency = 4;

export class ProjectRegistry {
  readonly #canonicalize: ProjectRegistryOptions["canonicalize"];
  readonly #createId: ProjectRegistryOptions["createId"];
  readonly #diagnostics: DiagnosticSink;
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #evaluationConcurrency: number;
  readonly #isActive: ProjectRegistryOptions["isActive"];
  readonly #loadDefinition: ProjectRegistryOptions["loadDefinition"];
  readonly #observer: ProjectDefinitionObserver;
  readonly #roots = new Map<string, RegistryEntry>();
  readonly #store: ProjectRegistrationStore;
  readonly #waitingForEvaluation: (() => void)[] = [];
  #activeEvaluations = 0;
  #closed = false;
  #mutationQueue: Promise<void> = Promise.resolve();

  private constructor(options: ProjectRegistryOptions) {
    this.#canonicalize = options.canonicalize;
    this.#createId = options.createId;
    this.#diagnostics = options.diagnostics;
    this.#evaluationConcurrency = options.evaluationConcurrency ?? defaultEvaluationConcurrency;
    this.#isActive = options.isActive;
    this.#loadDefinition = options.loadDefinition;
    this.#observer = options.observer;
    this.#store = options.store;

    if (!Number.isSafeInteger(this.#evaluationConcurrency) || this.#evaluationConcurrency < 1) {
      throw new TypeError("Project definition evaluation concurrency must be a positive integer.");
    }
  }

  static async open(options: ProjectRegistryOptions): Promise<Result<ProjectRegistry>> {
    const stored = await options.store.load();
    if (!stored.success) {
      return stored;
    }

    const registry = new ProjectRegistry(options);
    for (const registration of stored.output) {
      const entry: RegistryEntry = {
        ...registration,
        definition: { kind: "loading" },
        refreshAgain: false,
      };
      registry.#entries.set(entry.id, entry);
      registry.#roots.set(entry.root, entry);
      registry.#observe(entry);
      void registry.#refresh(entry).catch((error: unknown) => registry.#reportRefreshError(error));
    }
    return success(registry);
  }

  list(): readonly ProjectRegistration[] {
    return Object.freeze(
      [...this.#entries.values()]
        .map((entry) => snapshot(entry))
        .toSorted((left, right) => compareRegistrations(left, right)),
    );
  }

  add(path: string): Promise<Result<ProjectRegistration>> {
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
            message: "The generated project identifier is already registered.",
          }),
        );
      }

      const record = Object.freeze({ id, root: canonical.output });
      const saved = await this.#store.save([...this.#records(), record]);
      if (!saved.success) {
        return saved;
      }

      const entry: RegistryEntry = {
        ...record,
        definition: { kind: "loading" },
        refreshAgain: false,
      };
      this.#entries.set(entry.id, entry);
      this.#roots.set(entry.root, entry);
      this.#observe(entry);
      await this.#refresh(entry);
      return success(snapshot(entry));
    });
  }

  remove(target: string): Promise<Result<ProjectRegistration>> {
    return this.#mutate(async () => {
      const resolved = this.#resolve(target);
      if (!resolved.success) {
        return resolved;
      }
      const entry = resolved.output;
      if (this.#isActive(entry.root)) {
        return failure(
          createDiagnostic({
            code: "SYD4102",
            help: `Stop '${projectLabel(entry)}', then remove it again.`,
            message: "A running project cannot be removed from Stackyard.",
          }),
        );
      }

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
            help: "Open the project registry again before changing registrations.",
            message: "The project registry is closed.",
          }),
        ),
      );
    }

    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(noop, noop);
    return result;
  }

  #records(): ProjectRegistrationRecord[] {
    return [...this.#entries.values()]
      .map(({ id, root }) => Object.freeze({ id, root }))
      .toSorted((left, right) => left.root.localeCompare(right.root, "en"));
  }

  #resolve(target: string): Result<RegistryEntry> {
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
          help: "Remove the project by its registered identifier instead.",
          message: `More than one registered project is named '${target}'.`,
          notes: byName.map(({ id, root }) => `${id}: ${root}`),
        }),
      );
    }

    return failure(
      createDiagnostic({
        code: "SYD4100",
        help: "Run 'stackyard status' to list registered projects.",
        message: `No registered project matches '${target}'.`,
      }),
    );
  }

  #observe(entry: RegistryEntry): void {
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

  async #refresh(entry: RegistryEntry): Promise<void> {
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

  async #refreshLoop(entry: RegistryEntry): Promise<void> {
    do {
      entry.refreshAgain = false;
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Refreshes for one project must publish in order. */
      const loaded = await this.#evaluate(entry.root);
      if (this.#closed || this.#entries.get(entry.id) !== entry) {
        return;
      }

      if (loaded.kind === "valid") {
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

  #forget(entry: RegistryEntry): void {
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
        message: "A registered project could not be refreshed.",
        notes: [error instanceof Error ? error.message : String(error)],
      }),
    );
  }
}

function snapshot(entry: RegistryEntry): ProjectRegistration {
  return Object.freeze({ definition: entry.definition, id: entry.id, root: entry.root });
}

function compareRegistrations(left: ProjectRegistration, right: ProjectRegistration): number {
  const leftName = definitionName(left.definition) ?? left.root;
  const rightName = definitionName(right.definition) ?? right.root;
  return leftName.localeCompare(rightName, "en") || left.root.localeCompare(right.root, "en");
}

function definitionName(definition: ProjectDefinitionState): string | undefined {
  if (definition.kind === "valid") {
    return definition.spec.name;
  }
  if (definition.kind === "invalid" || definition.kind === "missing") {
    return definition.lastValidSpec?.name;
  }
  return undefined;
}

function lastValidDefinition(definition: ProjectDefinitionState): ProjectSpec | undefined {
  if (definition.kind === "valid") {
    return definition.spec;
  }
  if (definition.kind === "invalid" || definition.kind === "missing") {
    return definition.lastValidSpec;
  }
  return undefined;
}

function projectLabel(entry: RegistryEntry): string {
  return definitionName(entry.definition) ?? entry.id;
}

function noop(): void {}
