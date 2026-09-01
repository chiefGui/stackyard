Bun.serve({
  fetch: () => new Response("packed-fixture"),
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
});
