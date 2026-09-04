import {
  createDiagnostic,
  createDiagnosticReport,
  failure,
  type Failure,
} from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import { Context, Effect, Layer, Semaphore } from "effect";

import { definitionSpec, type CatalogProject, ProjectCatalog } from "./project-catalog.ts";
import type { Project, ProjectState, RuntimeProject, Service } from "./project-list.ts";
import {
  type ManagedProject,
  ProjectManager,
  type StartProjectFailure,
} from "./project-manager.ts";

export interface StartCatalogProjectInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentNamesCaseInsensitive: boolean;
  readonly root: string;
}

export class ProjectOrchestrator extends Context.Service<
  ProjectOrchestrator,
  {
    readonly add: (path: string) => Effect.Effect<Project, Failure>;
    readonly list: Effect.Effect<readonly Project[]>;
    readonly remove: (target: string) => Effect.Effect<Project, Failure>;
    readonly start: (
      input: StartCatalogProjectInput,
    ) => Effect.Effect<ManagedProject, StartProjectFailure>;
    readonly stop: (target: string) => Effect.Effect<Project, Failure>;
  }
>()("stackyard/control-plane/ProjectOrchestrator") {}

export const ProjectOrchestratorLayer: Layer.Layer<
  ProjectOrchestrator,
  never,
  ProjectCatalog | ProjectManager
> = Layer.effect(
  ProjectOrchestrator,
  Effect.gen(function* () {
    const catalog = yield* ProjectCatalog;
    const manager = yield* ProjectManager;
    const mutation = yield* Semaphore.make(1);

    const view = Effect.fn("ProjectOrchestrator.view")(function* (project: CatalogProject) {
      const runtime = yield* manager.findActiveProject(project.id);
      return projectView(project, runtime);
    });

    const list = Effect.gen(function* () {
      const projects = yield* catalog.list;
      return Object.freeze(yield* Effect.forEach(projects, view));
    });

    const add = Effect.fn("ProjectOrchestrator.add")((path: string) =>
      mutation.withPermits(1)(catalog.add(path).pipe(Effect.flatMap(view))),
    );

    const remove = Effect.fn("ProjectOrchestrator.remove")((target: string) =>
      mutation.withPermits(1)(
        Effect.gen(function* () {
          const project = yield* catalog.resolve(target);
          if (yield* manager.isActive(project.id)) {
            return yield* Effect.fail(
              failure(
                createDiagnostic({
                  code: "SYD4102",
                  help: `Stop '${projectName(project)}', then remove it again.`,
                  message: "A running project cannot be removed from Stackyard.",
                }),
              ),
            );
          }
          return yield* catalog.remove(project.id).pipe(Effect.flatMap(view));
        }),
      ),
    );

    const start = Effect.fn("ProjectOrchestrator.start")(function* (
      input: StartCatalogProjectInput,
    ): Effect.fn.Return<ManagedProject, StartProjectFailure> {
      const admitted = yield* mutation.withPermits(1)(
        Effect.gen(function* () {
          const project = yield* catalog.refreshByRoot(input.root);
          const definition = project.definition;
          if (definition.kind === "loading") {
            return yield* Effect.fail(
              failure(
                createDiagnostic({
                  code: "SYD4106",
                  help: "Wait for the project definition to finish loading, then retry.",
                  message: `Project '${projectName(project)}' is still loading.`,
                }),
              ),
            );
          }
          if (definition.kind !== "valid") {
            const [first, ...remaining] = definition.diagnostics;
            return yield* Effect.fail(failure(first, ...remaining));
          }
          return manager.start({
            environment: input.environment,
            environmentNamesCaseInsensitive: input.environmentNamesCaseInsensitive,
            id: project.id,
            revision: project.revision,
            root: project.root,
            spec: definition.spec,
          });
        }),
      );
      return yield* admitted;
    });

    const stop = Effect.fn("ProjectOrchestrator.stop")(function* (
      target: string,
    ): Effect.fn.Return<Project, Failure> {
      const project = yield* mutation.withPermits(1)(catalog.resolve(target));
      yield* manager.stop(project.id);
      return yield* view(project);
    });

    return ProjectOrchestrator.of({ add, list, remove, start, stop });
  }),
);

function projectView(project: CatalogProject, runtime: RuntimeProject | undefined): Project {
  const spec = definitionSpec(project.definition);
  const restartRequired = Boolean(
    runtime && project.definition.kind === "valid" && runtime.revision !== project.revision,
  );
  const services = mergeServices(spec?.resources, runtime);
  const issue =
    project.definition.kind === "invalid" || project.definition.kind === "missing"
      ? createDiagnosticReport(project.definition.diagnostics)
      : undefined;

  return Object.freeze({
    id: project.id,
    ...(issue ? { issue } : {}),
    name: spec?.name ?? runtime?.name ?? fallbackProjectName(project.root),
    restartRequired,
    root: project.root,
    services,
    state: projectState(project, runtime),
  });
}

function mergeServices(
  definedServices: ProjectSpec["resources"] | undefined,
  runtime: RuntimeProject | undefined,
): readonly Service[] {
  const runtimeServices = new Map(runtime?.services.map((service) => [service.name, service]));
  const names = new Set([...Object.keys(definedServices ?? {}), ...runtimeServices.keys()]);
  return Object.freeze(
    [...names]
      .toSorted((left, right) => left.localeCompare(right, "en"))
      .map((name) => {
        const active = runtimeServices.get(name);
        const startWithProject =
          definedServices?.[name]?.startWithProject ?? active?.startWithProject;
        if (startWithProject === undefined) {
          throw new Error("A service is missing its project startup policy.");
        }
        return Object.freeze(
          active
            ? { ...active, startWithProject }
            : {
                endpoints: Object.freeze([]),
                name,
                startWithProject,
                state: "stopped" as const,
              },
        );
      }),
  );
}

function projectState(project: CatalogProject, runtime: RuntimeProject | undefined): ProjectState {
  if (project.definition.kind === "invalid" || project.definition.kind === "missing") {
    return "needs-attention";
  }
  if (!runtime) {
    return project.definition.kind === "loading" ? "loading" : "stopped";
  }
  if (runtime.services.some(({ state }) => state === "failed")) {
    return "needs-attention";
  }
  if (runtime.services.every(({ state }) => state === "exited")) {
    return "needs-attention";
  }
  if (runtime.services.some(({ state }) => state === "stopping")) {
    return "stopping";
  }
  if (runtime.services.some(({ state }) => state === "starting")) {
    return "starting";
  }
  return "running";
}

function projectName(project: CatalogProject): string {
  return definitionSpec(project.definition)?.name ?? fallbackProjectName(project.root);
}

function fallbackProjectName(root: string): string {
  const segments = root.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.at(-1) ?? root;
}
