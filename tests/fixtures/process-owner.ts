import { resolve } from "node:path";

import { BunProcessHost } from "../../apps/daemon/src/processes.ts";

const started = await new BunProcessHost({ report() {} }).start({
  args: [resolve(import.meta.dir, "process-tree.ts")],
  env: { ...stringEnvironment(process.env) },
  executable: process.execPath,
  logs: { write() {} },
  projectRoot: resolve(import.meta.dir, "../.."),
  workingDirectory: ".",
});
if (!started.success) {
  throw new Error(started.diagnostics[0].message);
}

process.stdout.write(`${started.output.pid}\n`);
setInterval(() => {}, 1_000);

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
