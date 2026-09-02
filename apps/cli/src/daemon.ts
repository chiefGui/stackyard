import { defineCliCommandGroup, type CliCommand, type CliCommandGroup } from "./cli.ts";

export function createDaemonCommand(commands: readonly CliCommand[]): CliCommandGroup {
  return defineCliCommandGroup(
    "daemon",
    "SYD2019",
    { description: "Manage the Stackyard daemon" },
    commands,
  );
}
