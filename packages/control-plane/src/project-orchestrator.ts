import {
  createDiagnostic,
  createDiagnosticReport,
  failure,
  success,
  type Result,
} from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";

import { definitionSpec, type CatalogProject, type ProjectCatalog } from "./project-catalog.ts";
import type { Project, ProjectState, RuntimeProject, Service } from "./project-list.ts";
import {
  type CancellationSignal,
  type ProjectManager,
  type StartProjectResult,
} from "./project-manager.ts";

export interface StartCatalogProjectInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentNamesCaseInsensitive: boolean;
  readonly root: string;
  readonly signal?: CancellationSignal;
}

export class ProjectOrchestrator {
  readonly #catalog: ProjectCatalog;
  readonly #manager: ProjectManager;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(catalog: ProjectCatalog, manager: ProjectManager) {
    this.#catalog = catalog;
    this.#manager = manager;
  }

  list(): readonly Project[] {
    return Object.freeze(this.#catalog.list().map((project) => this.#view(project)));
  }

  async add(path: string): Promise<Result<Project>> {
    const added = await this.#mutate(() => this.#catalog.add(path));
    return added.success ? success(this.#view(added.output)) : added;
  }

  async remove(target: string): Promise<Result<Project>> {
    const removed = await this.#mutate(async () => {
      const project = this.#catalog.resolve(target);
      if (!project.success) {
        return project;
      }
      if (this.#manager.isActive(project.output.id)) {
        return failure(
          createDiagnostic({
            code: "SYD4102",
            help: `Stop '${projectName(project.output)}', then remove it again.`,
            message: "A running project cannot be removed from Stackyard.",
          }),
        );
      }
      return this.#catalog.remove(project.output.id);
    });
    return removed.success ? success(this.#view(removed.output)) : removed;
  }

  async start(input: StartCatalogProjectInput): Promise<StartProjectResult> {
    const admitted = await this.#mutate(() => this.#admitStart(input));
    return admitted.success ? admitted.output : admitted;
  }

  async stop(target: string): Promise<Result<Project>> {
    const resolved = await this.#mutate(() => this.#catalog.resolve(target));
    if (!resolved.success) {
      return resolved;
    }
    const stopped = await this.#manager.stop(resolved.output.id);
    return stopped.success ? success(this.#view(resolved.output)) : stopped;
  }

  #mutate<T>(operation: () => Promise<Result<T>> | Result<T>): Promise<Result<T>> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(noop, noop);
    return result;
  }

  async #admitStart(input: StartCatalogProjectInput): Promise<Result<Promise<StartProjectResult>>> {
    const refreshed = await this.#catalog.refreshByRoot(input.root);
    if (!refreshed.success) {
      return refreshed;
    }
    const project = refreshed.output;
    const definition = project.definition;
    if (definition.kind === "loading") {
      return failure(
        createDiagnostic({
          code: "SYD4106",
          help: "Wait for the project definition to finish loading, then retry.",
          message: `Project '${projectName(project)}' is still loading.`,
        }),
      );
    }
    if (definition.kind !== "valid") {
      const [first, ...remaining] = definition.diagnostics;
      return failure(first, ...remaining);
    }

    return success(
      this.#manager.start({
        environment: input.environment,
        environmentNamesCaseInsensitive: input.environmentNamesCaseInsensitive,
        id: project.id,
        revision: project.revision,
        root: project.root,
        ...(input.signal ? { signal: input.signal } : {}),
        spec: definition.spec,
      }),
    );
  }

  #view(project: CatalogProject): Project {
    const runtime = this.#manager.findActiveProject(project.id);
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
        const startup = definedServices?.[name]?.startup ?? active?.startup;
        if (!startup) {
          throw new Error("A service is missing its startup policy.");
        }
        return Object.freeze(
          active
            ? { ...active, startup }
            : { endpoints: Object.freeze([]), name, startup, state: "stopped" as const },
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

function noop(): void {}
