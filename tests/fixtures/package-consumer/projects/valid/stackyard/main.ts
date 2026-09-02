import { defineProject, endpoint, service } from "stackyard";

const api = service({
  command: ["bun", "--version"],
  endpoints: {
    http: endpoint.http({ env: "PORT" }),
  },
  startup: "manual",
});

export default defineProject({
  name: "package-consumer",
  resources: { api },
});
