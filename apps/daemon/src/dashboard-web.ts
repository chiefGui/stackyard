import { extname, join, normalize, relative, resolve } from "node:path";

import type { UnhandledRequestHandler } from "./server.ts";

export function createDashboardWebHandler(directory: string): UnhandledRequestHandler {
  const root = resolve(directory);

  return async (request, url) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Invalid path.", { status: 400 });
    }

    let requested: string;
    if (decoded === "/") {
      requested = "index.html";
    } else {
      requested = decoded.slice(1);
    }
    const filePath = normalize(join(root, requested));
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith("..") || relativePath.includes(":") || relativePath === "") {
      return new Response("Not found.", { status: 404 });
    }

    const response = await fileResponse(filePath);
    if (response) {
      return response;
    }

    if (isAppNavigation(request, decoded)) {
      const indexResponse = await fileResponse(join(root, "index.html"));
      if (indexResponse) {
        return indexResponse;
      }
    }
    return new Response("Not found.", { status: 404 });
  };
}

async function fileResponse(filePath: string): Promise<Response | undefined> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return undefined;
  }

  const cacheControl =
    extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
  return new Response(file, { headers: { "cache-control": cacheControl } });
}

function isAppNavigation(request: Request, path: string): boolean {
  return (
    request.method === "GET" &&
    path !== "/api" &&
    !path.startsWith("/api/") &&
    request.headers.get("accept")?.includes("text/html") === true
  );
}
