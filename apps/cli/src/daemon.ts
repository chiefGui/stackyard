import { defineCliCommandGroup, type CliCommand, type CliCommandGroup } from "./cli.ts";

export function createDaemonCommand<R>(commands: readonly CliCommand<R>[]): CliCommandGroup<R> {
  return defineCliCommandGroup(
    "daemon",
    "SYD2019",
    { description: "Manage the Stackyard daemon" },
    commands,
  );
}
