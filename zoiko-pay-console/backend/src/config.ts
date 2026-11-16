import { z } from "zod";

/** Validated configuration. Every value comes from the environment. */
export interface Config {
  port: number;
  production: boolean;
  logLevel: string;
  publicOrigin: string;
  oidc: { issuer: string; clientId: string; clientSecret: string };
  sessionSecret: string;
  /** Service client for creating accounts and setting passwords. */
  accountAdmin: { clientId: string; clientSecret: string };
  goServices: { name: string; baseUrl: string }[];
  dataSource: "fixtures";
}

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CONSOLE_PUBLIC_ORIGIN: z.url().default("http://localhost:5173"),
  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  ACCOUNT_ADMIN_CLIENT_ID: z.string().min(1).default("zoikopay-console-admin"),
  ACCOUNT_ADMIN_CLIENT_SECRET: z.string().min(1).default("local-dev-only-account-admin-secret"),
  GO_SERVICES: z.string().default(""),
  DATA_SOURCE: z.literal("fixtures").default("fixtures"),
});

export function parseGoServices(raw: string): { name: string; baseUrl: string }[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      const name = entry.slice(0, eq).trim();
      const baseUrl = entry.slice(eq + 1).trim();
      const url = new URL(baseUrl); // throws on malformed input
      if (eq <= 0 || !/^[a-z][a-z0-9-]*$/.test(name) || !["http:", "https:"].includes(url.protocol)) {
        throw new Error(`GO_SERVICES entry "${entry}" must be name=http(s)://host:port`);
      }
      return { name, baseUrl: baseUrl.replace(/\/$/, "") };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  if (production && (e.SESSION_SECRET.startsWith("local-dev-only") || e.ACCOUNT_ADMIN_CLIENT_SECRET.startsWith("local-dev-only"))) {
    throw new Error("SESSION_SECRET and ACCOUNT_ADMIN_CLIENT_SECRET must be replaced outside local development");
  }
  return {
    port: e.PORT,
    production,
    logLevel: e.LOG_LEVEL,
    publicOrigin: new URL(e.CONSOLE_PUBLIC_ORIGIN).origin,
    oidc: { issuer: e.OIDC_ISSUER, clientId: e.OIDC_CLIENT_ID, clientSecret: e.OIDC_CLIENT_SECRET },
    sessionSecret: e.SESSION_SECRET,
    accountAdmin: { clientId: e.ACCOUNT_ADMIN_CLIENT_ID, clientSecret: e.ACCOUNT_ADMIN_CLIENT_SECRET },
    goServices: parseGoServices(e.GO_SERVICES),
    dataSource: e.DATA_SOURCE,
  };
}
