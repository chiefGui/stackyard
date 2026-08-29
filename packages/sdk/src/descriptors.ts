const endpointStates = new WeakMap<object, HttpEndpointState>();
const serviceStates = new WeakMap<object, ServiceState>();
const valueStates = new WeakMap<object, RuntimeValueState>();

declare const endpointDescriptorBrand: unique symbol;
declare const runtimeValueBrand: unique symbol;
declare const serviceDescriptorBrand: unique symbol;

export type EnvironmentInputValue = string | RuntimeValue<number | string>;

export interface HttpEndpointDescriptor {
  readonly [endpointDescriptorBrand]: never;
}

export interface HttpEndpointOptions {
  readonly env: string;
  readonly preferredPort?: number;
}

export interface EndpointOutput {
  readonly host: RuntimeValue<string>;
  readonly port: RuntimeValue<number>;
  readonly url: RuntimeValue<string>;
}

export interface RuntimeValue<T extends number | string> {
  readonly [runtimeValueBrand]: T;
}

export interface ServiceDescriptor<Endpoints extends EndpointInputRecord = EndpointInputRecord> {
  readonly [serviceDescriptorBrand]: never;
  readonly endpoints: {
    readonly [Name in keyof Endpoints]: EndpointOutput;
  };
}

export interface ServiceOptions<Endpoints extends EndpointInputRecord> {
  readonly command: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly endpoints?: Endpoints;
  readonly env?: Readonly<Record<string, EnvironmentInputValue>>;
}

export type EndpointInputRecord = Readonly<Record<string, HttpEndpointDescriptor>>;

export const endpoint = Object.freeze({
  http(options: HttpEndpointOptions): HttpEndpointDescriptor {
    const descriptor = Object.freeze({}) as HttpEndpointDescriptor;
    endpointStates.set(descriptor, { ...options });
    return descriptor;
  },
});

export function service<const Endpoints extends EndpointInputRecord = Record<never, never>>(
  options: ServiceOptions<Endpoints>,
): ServiceDescriptor<Endpoints> {
  const state: ServiceState = {
    command: [...options.command],
    cwd: options.cwd ?? ".",
    endpoints: { ...options.endpoints },
    env: { ...options.env },
  };

  const outputs = Object.fromEntries(
    Object.keys(state.endpoints).map((name) => [name, createEndpointOutput(state, name)]),
  ) as ServiceDescriptor<Endpoints>["endpoints"];

  const descriptor = Object.freeze({
    endpoints: Object.freeze(outputs),
  }) as ServiceDescriptor<Endpoints>;
  serviceStates.set(descriptor, state);
  return descriptor;
}

export interface HttpEndpointState {
  readonly env: string;
  readonly preferredPort?: number;
}

export interface ServiceState {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly endpoints: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, unknown>>;
}

export interface RuntimeValueState {
  readonly endpoint: string;
  readonly field: "host" | "port" | "url";
  readonly service: ServiceState;
}

export function getEndpointState(value: unknown): HttpEndpointState | undefined {
  return isObject(value) ? endpointStates.get(value) : undefined;
}

export function getServiceState(value: unknown): ServiceState | undefined {
  return isObject(value) ? serviceStates.get(value) : undefined;
}

export function getRuntimeValueState(value: unknown): RuntimeValueState | undefined {
  return isObject(value) ? valueStates.get(value) : undefined;
}

function createEndpointOutput(serviceState: ServiceState, endpointName: string): EndpointOutput {
  return Object.freeze({
    host: createRuntimeValue<string>({
      endpoint: endpointName,
      field: "host",
      service: serviceState,
    }),
    port: createRuntimeValue<number>({
      endpoint: endpointName,
      field: "port",
      service: serviceState,
    }),
    url: createRuntimeValue<string>({
      endpoint: endpointName,
      field: "url",
      service: serviceState,
    }),
  });
}

function createRuntimeValue<T extends number | string>(state: RuntimeValueState): RuntimeValue<T> {
  const value = Object.create(null) as object;
  Object.defineProperty(value, Symbol.toPrimitive, {
    value() {
      throw new TypeError(
        "Stackyard runtime values cannot be converted to strings while defining a project. Pass the value directly.",
      );
    },
  });
  Object.freeze(value);
  valueStates.set(value, state);
  return value as RuntimeValue<T>;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
