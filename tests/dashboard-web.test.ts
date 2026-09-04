import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { createDashboardWebHandler } from "../apps/daemon/src/dashboard-web.ts";

test("dashboard delivery serves files and falls back only for app navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-dashboard-"));
  const assets = join(directory, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(join(directory, "index.html"), "<main>Stackyard</main>"),
    writeFile(join(assets, "app.js"), "export {};"),
  ]);

  try {
    const handle = createDashboardWebHandler(directory);
    const request = (input: Request, url: URL) => Effect.runPromise(handle(input, url));
    const assetUrl = new URL("http://127.0.0.1/assets/app.js");
    const asset = await request(new Request(assetUrl.href), assetUrl);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("export {};");

    const routeUrl = new URL("http://127.0.0.1/projects/example");
    const route = await request(
      new Request(routeUrl.href, { headers: { accept: "text/html,application/xhtml+xml" } }),
      routeUrl,
    );
    expect(route.status).toBe(200);
    expect(route.headers.get("cache-control")).toBe("no-cache");
    expect(await route.text()).toBe("<main>Stackyard</main>");

    const postedRoute = await request(
      new Request(routeUrl.href, { headers: { accept: "text/html" }, method: "POST" }),
      routeUrl,
    );
    expect(postedRoute.status).toBe(404);

    const missingAssetUrl = new URL("http://127.0.0.1/assets/missing.js");
    const missingAsset = await request(new Request(missingAssetUrl.href), missingAssetUrl);
    expect(missingAsset.status).toBe(404);

    const missingApiUrl = new URL("http://127.0.0.1/api/v1/missing");
    const missingApi = await request(
      new Request(missingApiUrl.href, { headers: { accept: "text/html" } }),
      missingApiUrl,
    );
    expect(missingApi.status).toBe(404);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
