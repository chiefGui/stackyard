Bun.serve({
  fetch: () => new Response("Hello from Stackyard."),
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
});
