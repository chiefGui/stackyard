import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface StackyardDirectories {
  readonly data: string;
  readonly runtime: string;
}

export interface StackyardDirectoryOptions {
  readonly currentDirectory?: string;
  readonly dataOverride?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly runtimeOverride?: string;
}

export function resolveStackyardDirectories(
  options: StackyardDirectoryOptions = {},
): StackyardDirectories {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const currentDirectory = path.resolve(options.currentDirectory ?? process.cwd());
  const homeDirectory = path.resolve(currentDirectory, options.homeDirectory ?? homedir());
  const dataOverride = options.dataOverride ?? environment.STACKYARD_DATA_DIR;
  const runtimeOverride = options.runtimeOverride ?? environment.STACKYARD_RUNTIME_DIR;

  const platformDirectories = defaultDirectories(platform, environment, homeDirectory);
  return Object.freeze({
    data: dataOverride ? path.resolve(currentDirectory, dataOverride) : platformDirectories.data,
    runtime: runtimeOverride
      ? path.resolve(currentDirectory, runtimeOverride)
      : platformDirectories.runtime,
  });
}

function defaultDirectories(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): StackyardDirectories {
  const path = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    const localApplicationData =
      absoluteOrUndefined(environment.LOCALAPPDATA, path.isAbsolute) ??
      path.join(homeDirectory, "AppData", "Local");
    const directory = path.join(localApplicationData, "Stackyard");
    return { data: directory, runtime: directory };
  }

  const runtimeRoot = absoluteOrUndefined(environment.XDG_RUNTIME_DIR, path.isAbsolute);
  const runtime = runtimeRoot
    ? path.join(runtimeRoot, "stackyard")
    : path.join(homeDirectory, ".stackyard", "run");
  if (platform === "darwin") {
    return {
      data: path.join(homeDirectory, "Library", "Application Support", "Stackyard"),
      runtime,
    };
  }

  const stateRoot =
    absoluteOrUndefined(environment.XDG_STATE_HOME, path.isAbsolute) ??
    path.join(homeDirectory, ".local", "state");
  return { data: path.join(stateRoot, "stackyard"), runtime };
}

function absoluteOrUndefined(
  value: string | undefined,
  isAbsolute: (path: string) => boolean,
): string | undefined {
  return value && isAbsolute(value) ? value : undefined;
}
