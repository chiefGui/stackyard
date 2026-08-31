Bun.serve({
  fetch(request) {
    return new URL(request.url).pathname === "/environment"
      ? Response.json({
          processStart: process.env.STACKYARD_PROCESS_START ?? null,
          runtimeDirectory: process.env.STACKYARD_RUNTIME_DIR ?? null,
          value: process.env.RUN_FIXTURE_VALUE ?? null,
        })
      : new Response("fixture");
  },
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
});
