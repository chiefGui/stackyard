import { defineProject, endpoint, service } from "stackyard";

const api = service({
  command: ["bun", "run", "dev"],
  cwd: "apps/api",
  endpoints: {
    http: endpoint.http({
      env: "PORT",
      preferredPort: 3000,
    }),
  },
});

export default defineProject({
  name: "basic",
  resources: {
    api,
    web: service({
      command: ["bun", "run", "dev"],
      cwd: "apps/web",
      env: {
        API_URL: api.endpoints.http.url,
      },
    }),
  },
});
