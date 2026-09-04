import {
  createDiagnostic,
  failure,
  success,
  type DiagnosticSink,
  type Failure,
  type NonEmptyDiagnostics,
  type Result,
} from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import { Context, Effect, Exit, Layer, Queue, Scope, Semaphore } from "effect";

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

export class ProjectStore extends Context.Service<
  ProjectStore,
  {
    readonly load: Effect.Effect<readonly ProjectRecord[], Failure>;
    readonly save: (projects: readonly ProjectRecord[]) => Effect.Effect<void, Failure>;
  }
>()("stackyard/control-plane/ProjectStore") {}

export class ProjectDefinitionLoader extends Context.Service<
  ProjectDefinitionLoader,
  {
    readonly load: (root: string) => Effect.Effect<ProjectDefinitionLoad>;
  }
>()("stackyard/control-plane/ProjectDefinitionLoader") {}

export class ProjectDefinitionObserver extends Context.Service<
  ProjectDefinitionObserver,
  {
    readonly observe: (
      root: string,
      onChange: () => void,
    ) => Effect.Effect<void, Failure, Scope.Scope>;
  }
>()("stackyard/control-plane/ProjectDefinitionObserver") {}

export class ProjectRootResolver extends Context.Service<
  ProjectRootResolver,
  {
    readonly canonicalize: (path: string) => Effect.Effect<string, Failure>;
  }
>()("stackyard/control-plane/ProjectRootResolver") {}

export class ProjectIdGenerator extends Context.Service<
  ProjectIdGenerator,
  {
    readonly next: Effect.Effect<string>;
  }
>()("stackyard/control-plane/ProjectIdGenerator") {}

export interface ProjectCatalogOptions {
  readonly diagnostics: DiagnosticSink;
  readonly evaluationConcurrency?: number;
}

interface CatalogEntry extends ProjectRecord {
  readonly changes: Queue.Queue<void>;
  readonly refresh: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  definition: ProjectDefinitionState;
  revision: number;
}

const defaultEvaluationConcurrency = 4;

export class ProjectCatalog extends Context.Service<
  ProjectCatalog,
  {
    readonly add: (path: string) => Effect.Effect<CatalogProject, Failure>;
    readonly list: Effect.Effect<readonly CatalogProject[]>;
    readonly refreshByRoot: (root: string) => Effect.Effect<CatalogProject, Failure>;
    readonly remove: (target: string) => Effect.Effect<CatalogProject, Failure>;
    readonly resolve: (target: string) => Effect.Effect<CatalogProject, Failure>;
  }
>()("stackyard/control-plane/ProjectCatalog") {}

type ProjectCatalogDependencies =
  | ProjectDefinitionLoader
  | ProjectDefinitionObserver
  | ProjectIdGenerator
  | ProjectRootResolver
  | ProjectStore;

export function makeProjectCatalogLayer(
  options: ProjectCatalogOptions,
): Layer.Layer<ProjectCatalog, Failure, ProjectCatalogDependencies> {
  return Layer.effect(ProjectCatalog, makeProjectCatalog(options));
}

export const makeProjectCatalog = Effect.fn("makeProjectCatalog")(function* (
  options: ProjectCatalogOptions,
): Effect.fn.Return<ProjectCatalog["Service"], Failure, ProjectCatalogDependencies | Scope.Scope> {
  const concurrency = positiveInteger(
    options.evaluationConcurrency,
    defaultEvaluationConcurrency,
    "evaluationConcurrency",
  );
  const loader = yield* ProjectDefinitionLoader;
  const observer = yield* ProjectDefinitionObserver;
  const identifiers = yield* ProjectIdGenerator;
  const roots = yield* ProjectRootResolver;
  const store = yield* ProjectStore;
  const evaluation = yield* Semaphore.make(concurrency);
  const mutation = yield* Semaphore.make(1);
  const records = yield* store.load;
  const live = new ProjectCatalogLive(
    options.diagnostics,
    evaluation,
    identifiers,
    loader,
    mutation,
    observer,
    roots,
    store,
  );
  yield* live.initialize(records);
  yield* Effect.addFinalizer(() => live.close);
  return ProjectCatalog.of({
    add: live.add,
    list: live.list,
    refreshByRoot: live.refreshByRoot,
    remove: live.remove,
    resolve: live.resolve,
  });
});

class ProjectCatalogLive {
  readonly #diagnostics: DiagnosticSink;
  readonly #entries = new Map<string, CatalogEntry>();
  readonly #evaluation: Semaphore.Semaphore;
  readonly #identifiers: ProjectIdGenerator["Service"];
  readonly #loader: ProjectDefinitionLoader["Service"];
  readonly #mutation: Semaphore.Semaphore;
  readonly #observer: ProjectDefinitionObserver["Service"];
  readonly #roots = new Map<string, CatalogEntry>();
  readonly #rootResolver: ProjectRootResolver["Service"];
  readonly #store: ProjectStore["Service"];

  constructor(
    diagnostics: DiagnosticSink,
    evaluation: Semaphore.Semaphore,
    identifiers: ProjectIdGenerator["Service"],
    loader: ProjectDefinitionLoader["Service"],
    mutation: Semaphore.Semaphore,
    observer: ProjectDefinitionObserver["Service"],
    rootResolver: ProjectRootResolver["Service"],
    store: ProjectStore["Service"],
  ) {
    this.#diagnostics = diagnostics;
    this.#evaluation = evaluation;
    this.#identifiers = identifiers;
    this.#loader = loader;
    this.#mutation = mutation;
    this.#observer = observer;
    this.#rootResolver = rootResolver;
    this.#store = store;
  }

  readonly initialize = Effect.fn("ProjectCatalog.initialize")(
    function* (this: ProjectCatalogLive, records: readonly ProjectRecord[]) {
      for (const record of records) {
        const entry = yield* this.#createEntry(record);
        this.#entries.set(entry.id, entry);
        this.#roots.set(entry.root, entry);
        yield* this.#activate(entry);
        Queue.offerUnsafe(entry.changes, undefined);
      }
    }.bind(this),
  );

  readonly list: Effect.Effect<readonly CatalogProject[]> = Effect.sync(() =>
    Object.freeze(
      [...this.#entries.values()]
        .map((entry) => snapshot(entry))
        .toSorted((left, right) => compareProjects(left, right)),
    ),
  );

  readonly refreshByRoot = Effect.fn("ProjectCatalog.refreshByRoot")(
    function* (this: ProjectCatalogLive, root: string): Effect.fn.Return<CatalogProject, Failure> {
      const entry = this.#roots.get(root);
      if (!entry) {
        return yield* Effect.fail(
          failure(
            createDiagnostic({
              code: "SYD4100",
              help: "Run 'stackyard add .' from this project, then retry.",
              message: "This project has not been added to Stackyard.",
              notes: [root],
            }),
          ),
        );
      }
      yield* this.#refresh(entry);
      return snapshot(entry);
    }.bind(this),
  );

  readonly resolve = Effect.fn("ProjectCatalog.resolve")((target: string) =>
    Effect.sync(() => this.#resolve(target)).pipe(
      Effect.flatMap((result) =>
        result.success ? Effect.succeed(snapshot(result.output)) : Effect.fail(result),
      ),
    ),
  );

  readonly add = Effect.fn("ProjectCatalog.add")((path: string) =>
    this.#mutation.withPermits(1)(
      Effect.gen(
        function* (this: ProjectCatalogLive) {
          const root = yield* this.#rootResolver.canonicalize(path);
          const existing = this.#roots.get(root);
          if (existing) {
            yield* this.#refresh(existing);
            return snapshot(existing);
          }

          const id = yield* this.#identifiers.next;
          if (this.#entries.has(id)) {
            return yield* Effect.fail(
              failure(
                createDiagnostic({
                  code: "SYD4103",
                  help: "Retry the command to generate another project identifier.",
                  message: "The generated project identifier already belongs to another project.",
                }),
              ),
            );
          }

          const record = Object.freeze({ id, root });
          yield* this.#store.save([...this.#records(), record]);
          const entry = yield* this.#createEntry(record);
          this.#entries.set(entry.id, entry);
          this.#roots.set(entry.root, entry);
          yield* this.#activate(entry);
          yield* this.#refresh(entry);
          return snapshot(entry);
        }.bind(this),
      ),
    ),
  );

  readonly remove = Effect.fn("ProjectCatalog.remove")((target: string) =>
    this.#mutation.withPermits(1)(
      Effect.gen(
        function* (this: ProjectCatalogLive) {
          const resolved = this.#resolve(target);
          if (!resolved.success) {
            return yield* Effect.fail(resolved);
          }
          const entry = resolved.output;
          yield* this.#store.save(this.#records().filter(({ id }) => id !== entry.id));
          this.#entries.delete(entry.id);
          if (this.#roots.get(entry.root) === entry) {
            this.#roots.delete(entry.root);
          }
          yield* Scope.close(entry.scope, Exit.void);
          return snapshot(entry);
        }.bind(this),
      ),
    ),
  );

  readonly close: Effect.Effect<void> = Effect.gen(
    function* (this: ProjectCatalogLive) {
      const entries = [...this.#entries.values()];
      yield* Effect.forEach(entries, (entry) => Scope.close(entry.scope, Exit.void), {
        concurrency: "unbounded",
      });
    }.bind(this),
  );

  #records(): ProjectRecord[] {
    return [...this.#entries.values()]
      .map(({ id, root }) => Object.freeze({ id, root }))
      .toSorted((left, right) => left.root.localeCompare(right.root, "en"));
  }

  #resolve(target: string): Result<CatalogEntry> {
    const byId = this.#entries.get(target);
    if (byId) {
      return resolvedEntry(byId);
    }
    const byRoot = this.#roots.get(target);
    if (byRoot) {
      return resolvedEntry(byRoot);
    }
    const byName = [...this.#entries.values()].filter(
      (entry) => definitionName(entry.definition) === target,
    );
    if (byName.length === 1 && byName[0]) {
      return resolvedEntry(byName[0]);
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

  #createEntry = Effect.fn("ProjectCatalog.createEntry")(function* (
    record: ProjectRecord,
  ): Effect.fn.Return<CatalogEntry> {
    return {
      ...record,
      changes: yield* Queue.sliding<void>(1),
      definition: { kind: "loading" },
      refresh: yield* Semaphore.make(1),
      revision: 0,
      scope: yield* Scope.make(),
    };
  });

  #activate = Effect.fn("ProjectCatalog.activate")(
    function* (this: ProjectCatalogLive, entry: CatalogEntry) {
      const observed = yield* Scope.provide(
        this.#observer.observe(entry.root, () => {
          Queue.offerUnsafe(entry.changes, undefined);
        }),
        entry.scope,
      ).pipe(Effect.match({ onFailure: (value) => value, onSuccess: () => undefined }));
      if (observed) {
        for (const diagnostic of observed.diagnostics) {
          this.#diagnostics.report(diagnostic);
        }
      }
      yield* Effect.forkIn(
        Effect.forever(Queue.take(entry.changes).pipe(Effect.andThen(this.#refresh(entry)))),
        entry.scope,
      );
    }.bind(this),
  );

  #refresh(entry: CatalogEntry): Effect.Effect<void> {
    return entry.refresh.withPermits(1)(
      this.#evaluation
        .withPermits(1)(this.#loader.load(entry.root))
        .pipe(
          Effect.tap((loaded) =>
            Effect.sync(() => {
              if (this.#entries.get(entry.id) !== entry) {
                return;
              }
              if (loaded.kind === "valid") {
                const previous = lastValidDefinition(entry.definition);
                if (!previous || !sameProjectSpec(previous, loaded.spec)) {
                  entry.revision += 1;
                }
                entry.definition = Object.freeze({ kind: "valid", spec: loaded.spec });
                return;
              }
              const lastValidSpec = lastValidDefinition(entry.definition);
              entry.definition = Object.freeze({
                diagnostics: loaded.diagnostics,
                kind: loaded.kind,
                ...(lastValidSpec ? { lastValidSpec } : {}),
              });
            }),
          ),
          Effect.asVoid,
        ),
    );
  }
}

function resolvedEntry(entry: CatalogEntry) {
  return success(entry);
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

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`Project definition ${name} must be a positive integer.`);
  }
  return resolved;
}
