// Entry point: load config, build the app, run one cleanup pass, then serve.
import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);
await app.runCleanupOnce();
const cleanupTimer = app.startCleanupLoop();

const server = Bun.serve({
  port: config.port,
  maxRequestBodySize: config.maxUploadBytes + 1024 * 1024,
  fetch: app.fetch,
  error(error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "server_error",
        time: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(
  JSON.stringify({
    level: "info",
    event: "server_started",
    time: new Date().toISOString(),
    url: server.url.toString(),
    storageDir: config.storageDir,
    databasePath: config.databasePath,
  }),
);

async function shutdown(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  await server.stop();
  app.close();
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
