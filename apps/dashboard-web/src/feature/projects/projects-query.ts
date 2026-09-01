import { queryOptions } from "@tanstack/react-query";

import { daemonClient } from "../../infra/daemon/client.ts";

const refreshMilliseconds = 1_000;

export const projectsQueryOptions = queryOptions({
  networkMode: "always",
  queryFn: ({ signal }) => daemonClient.listProjects({ signal }),
  queryKey: ["projects", "list"],
  refetchInterval: refreshMilliseconds,
  refetchIntervalInBackground: true,
  retry: false,
});
