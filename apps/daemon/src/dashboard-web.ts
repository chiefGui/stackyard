import { extname, join, normalize, relative, resolve } from "node:path";

import type { UnhandledRequestHandler } from "./server.ts";

export function createDashboardWebHandler(directory: string): UnhandledRequestHandler {
  const root = resolve(directory);

  return async (_request, url) => {
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

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found.", { status: 404 });
    }

    let cacheControl = "public, max-age=31536000, immutable";
    if (extname(filePath) === ".html") {
      cacheControl = "no-cache";
    }
    return new Response(file, { headers: { "cache-control": cacheControl } });
  };
}
