import { defineProject, service } from "../../../../apps/cli/src/index.ts";

export default defineProject({
  name: "invalid",
  resources: {
    api: service({
      command: ["bun", "api.ts"],
      cwd: "../outside",
    }),
  },
});
