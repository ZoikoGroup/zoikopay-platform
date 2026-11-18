import express, { type Express } from "express";
import session, { MemoryStore, type Store } from "express-session";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { Config } from "./config.js";
import { FixtureDataSource, type ConsoleDataSource } from "./database/dataSource.js";
import { generateFixtures } from "./database/fixtures.js";
import { ScreenStore } from "./screens/store.js";
import { DEV_MEMBERSHIPS, type MembershipDirectory } from "./integrations/directory.js";
import { AccessStore } from "./services/access.js";
import { ExceptionalAccessStore } from "./services/exceptional.js";
import { KeycloakAccountAdmin, type AccountAdmin } from "./integrations/accounts.js";
import type { IdentityProvider } from "./integrations/oidc.js";
import { errorHandler, notFoundRoute, originCheck, requestContext } from "./middleware/http.js";
import { apiRoutes, authRoutes } from "./routes/index.js";
import { AuditLog } from "./services/audit.js";
import type { Services } from "./services/context.js";
import { HealthMonitor } from "./services/health.js";

export const SESSION_COOKIE = "zp_console_sid";
export const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface AppDeps {
  config: Config;
  log: Logger;
  idp: IdentityProvider;
  accounts?: AccountAdmin;
  sessionStore?: Store;
  data?: ConsoleDataSource;
  directory?: MembershipDirectory;
  now?: () => number;
  health?: HealthMonitor;
}

export function createApp(deps: AppDeps): { app: Express; services: Services; health: HealthMonitor } {
  const { config, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Roles are grants managed on the Access screen, seeded with the local users.
  const access = new AccessStore(DEV_MEMBERSHIPS, now);
  const accounts = deps.accounts ?? new KeycloakAccountAdmin(config);
  const services: Services = {
    data: deps.data ?? new FixtureDataSource(startedAt),
    // Same seed and start time as the data source, so screens and dashboard agree.
    screens: new ScreenStore(generateFixtures(startedAt), startedAt),
    audit: new AuditLog(() => new Date(now())),
    directory: deps.directory ?? access,
    access,
    exceptional: new ExceptionalAccessStore(now),
    now,
  };
  const health = deps.health ?? new HealthMonitor(config.goServices, config.oidc.issuer, log);

  const app = express();
  app.disable("x-powered-by");
  // Behind the frontend server's proxy (Vite in development).
  app.set("trust proxy", "loopback");

  app.use(requestContext);
  app.use(pinoHttp({
    logger: log,
    serializers: { req: (request) => typeof request.url === 'string' && request.url.startsWith('/auth/sso/callback')
      ? { ...request, url: '/auth/sso/callback', query: undefined } : request },
    genReqId: (req) => (req as express.Request).requestId,
    redact: ["req.headers.cookie", "req.headers.authorization", "req.headers.referer", 'res.headers["set-cookie"]', 'res.headers.location'],
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
  }));
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: config.production,
  }));
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use(session({
    name: SESSION_COOKIE,
    secret: config.sessionSecret,
    store: deps.sessionStore ?? new MemoryStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: "lax", secure: config.production, maxAge: SESSION_IDLE_MS, path: "/" },
  }));
  app.use(originCheck(config.publicOrigin));

  app.use("/auth", authRoutes(services, deps.idp, accounts, config));
  app.use("/api/v1", apiRoutes(services, health, accounts));
  app.use(notFoundRoute);
  app.use(errorHandler(log));

  return { app, services, health };
}
