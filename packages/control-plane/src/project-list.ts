export type ServiceState = "starting" | "running" | "stopping" | "exited" | "failed";

export interface ServiceEndpoint {
  readonly name: string;
  readonly url: string;
}

export interface Service {
  readonly endpoints: readonly ServiceEndpoint[];
  readonly exitCode?: number | undefined;
  readonly name: string;
  readonly state: ServiceState;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly services: readonly Service[];
}

export interface ProjectList {
  readonly projects: readonly Project[];
}
