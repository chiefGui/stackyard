import type { DiagnosticReport } from "@stackyard/diagnostics";
import type { ServiceStartup } from "@stackyard/protocol";

export type ProjectState =
  | "loading"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "needs-attention";

export type ServiceState = RuntimeServiceState | "stopped";

export interface Service {
  readonly endpoints: readonly RuntimeServiceEndpoint[];
  readonly exitCode?: number | undefined;
  readonly name: string;
  readonly state: ServiceState;
  readonly startup: ServiceStartup;
}

export interface Project {
  readonly id: string;
  readonly issue?: DiagnosticReport | undefined;
  readonly name: string;
  readonly restartRequired: boolean;
  readonly root: string;
  readonly services: readonly Service[];
  readonly state: ProjectState;
}

export type RuntimeServiceState = "starting" | "running" | "stopping" | "exited" | "failed";

export interface RuntimeServiceEndpoint {
  readonly name: string;
  readonly url: string;
}

export interface RuntimeService {
  readonly endpoints: readonly RuntimeServiceEndpoint[];
  readonly exitCode?: number | undefined;
  readonly name: string;
  readonly state: RuntimeServiceState;
  readonly startup: ServiceStartup;
}

export interface RuntimeProject {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly root: string;
  readonly services: readonly RuntimeService[];
}

export interface RuntimeProjectList {
  readonly projects: readonly RuntimeProject[];
}
