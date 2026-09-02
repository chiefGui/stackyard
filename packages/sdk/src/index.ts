export type {
  EndpointInputRecord,
  EndpointOutput,
  EnvironmentInputValue,
  HttpEndpointDescriptor,
  HttpEndpointOptions,
  RuntimeValue,
  ServiceDescriptor,
  ServiceOptions,
} from "./descriptors.ts";
export type { ServiceStartup } from "@stackyard/protocol";
export { endpoint, service } from "./descriptors.ts";
export type { ProjectDefinition, ProjectOptions, ResourceInputRecord } from "./project.ts";
export { defineProject, readProjectDefinition } from "./project.ts";
