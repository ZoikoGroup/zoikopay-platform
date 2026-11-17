import { pino } from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { KeycloakProvider } from "./integrations/oidc.js";

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "zoiko-pay-console-backend" } });

if (!config.production) {
  log.warn("development mode: in-memory sessions, audit log and fixtures; not for production use");
}

const { app, health } = createApp({ config, log, idp: new KeycloakProvider(config) });
health.start();

const server = app.listen(config.port, () => {
  log.info({ port: config.port, publicOrigin: config.publicOrigin, dataSource: config.dataSource }, "console backend listening");
});

function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  health.stop();
  server.close((err) => {
    if (err) {
      log.error({ err }, "shutdown error");
      process.exit(1);
    }
    log.info("stopped");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
