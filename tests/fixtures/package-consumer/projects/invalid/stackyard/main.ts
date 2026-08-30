import { defineProject, service } from "stackyard";

export default defineProject({
  name: "package-consumer-invalid",
  resources: {
    api: service({
      command: ["bun", "--version"],
      cwd: "../outside",
    }),
  },
});
