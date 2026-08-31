const mode = Bun.argv[2];

if (mode === "child") {
  Bun.serve({
    fetch: () => new Response("child"),
    hostname: "127.0.0.1",
    port: Number(process.env.CHILD_PORT),
  });
  console.log("ready");
} else {
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.path, "child"],
    env: process.env,
    stderr: "ignore",
    stdin: "ignore",
    stdout: mode === "orphan" ? "pipe" : "ignore",
    windowsHide: true,
  });
  if (mode === "orphan") {
    const reader = child.stdout.getReader();
    await reader.read();
    await reader.cancel();
    reader.releaseLock();
    child.unref();
    process.stdout.write(`${child.pid}\n`);
  } else {
    setInterval(() => {}, 1_000);
  }
}
