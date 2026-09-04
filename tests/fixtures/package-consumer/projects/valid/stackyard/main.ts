import { defineProject, endpoint, service } from "stackyard";

const api = service({
  command: ["bun", "--version"],
  endpoints: {
    http: endpoint.http({ env: "PORT" }),
  },
  startWithProject: false,
});

export default defineProject({
  name: "package-consumer",
  resources: { api },
});
