import { createHmac, randomUUID } from "node:crypto";
import { MemoryStore } from "express-session";
import { pino } from "pino";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import type { Environment } from "../src/types/domain.js";
import type { Config } from "../src/config.js";
import type { Account } from "../src/integrations/accounts.js";
import { DEV_MEMBERSHIPS } from "../src/integrations/directory.js";
import type { IdentityClaims, IdentityProvider } from "../src/integrations/oidc.js";
import { HealthMonitor } from "../src/services/health.js";
import { AppError } from "../src/types/errors.js";

export const ORIGIN = "http://localhost:5173";
export const PASSWORD = "Zoiko@123";
const SECRET = "test-only-session-secret-0123456789abcdef";

export const testConfig: Config = {
  port: 0,
  production: false,
  logLevel: "silent",
  publicOrigin: ORIGIN,
  oidc: { issuer: "http://idp.test/realms/zoikopay", clientId: "zoikopay-console", clientSecret: "test" },
  accountAdmin: { clientId: "zoikopay-console-admin", clientSecret: "test" },
  sessionSecret: SECRET,
  goServices: [],
  dataSource: "fixtures",
};

/** Accepts every directory user with PASSWORD; records logouts. */
export class FakeIdp implements IdentityProvider {
  loggedOut: (string | undefined)[] = [];
  extraUsers = new Map<string, IdentityClaims>();
  async passwordLogin(username: string, password: string): Promise<IdentityClaims> {
    const extra = this.extraUsers.get(username);
    const m = DEV_MEMBERSHIPS.find((x) => x.username === username);
    if (password !== PASSWORD || (!m && !extra)) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid username or password");
    return extra ?? { sub: m!.sub, username: m!.username, displayName: m!.displayName, authTime: Math.floor(Date.now() / 1000), refreshToken: `rt-${username}` };
  }
  async logout(refreshToken: string | undefined) {
    this.loggedOut.push(refreshToken);
  }
}

/** Records created accounts and password changes; enforces username uniqueness. */
export class FakeAccounts {
  created: string[] = [];
  passwords = new Map<string, string>();
  /** Accounts created here, with a generated `sub`, as Zoiko iD would. */
  extra: Account[] = [];
  async createAccount(i: { username: string; password: string; firstName?: string; lastName?: string }) {
    if (DEV_MEMBERSHIPS.some((m) => m.username === i.username) || this.created.includes(i.username)) {
      throw new AppError(409, "USERNAME_TAKEN", "That username or email is not available");
    }
    this.created.push(i.username);
    this.extra.push({ sub: randomUUID(), username: i.username, displayName: `${i.firstName ?? ""} ${i.lastName ?? ""}`.trim() || i.username, enabled: true });
  }
  async listAccounts(): Promise<Account[]> {
    return [...DEV_MEMBERSHIPS.map((m) => ({ sub: m.sub, username: m.username, displayName: m.displayName, enabled: true })), ...this.extra];
  }
  async findAccount(username: string): Promise<Account | undefined> {
    return (await this.listAccounts()).find((a) => a.username === username);
  }
  async setPassword(username: string, password: string) {
    this.passwords.set(username, password);
  }
}

export function makeTestApp(opts: { now?: () => number } = {}) {
  const store = new MemoryStore();
  const idp = new FakeIdp();
  const accounts = new FakeAccounts();
  const log = pino({ level: "silent" });
  const health = new HealthMonitor([], testConfig.oidc.issuer, log);
  const { app, services } = createApp({ config: testConfig, log, idp, accounts, sessionStore: store, health, now: opts.now });

  /** Creates a real server-side session for a directory user and returns its signed cookie. */
  function loginAs(username: string, o: { environment?: Environment; loginAgoMs?: number } = {}): string {
    const m = DEV_MEMBERSHIPS.find((x) => x.username === username);
    if (!m) throw new Error(`unknown test user ${username}`);
    const now = services.now();
    const sid = randomUUID();
    const sess = {
      cookie: { originalMaxAge: 1_800_000, expires: new Date(now + 1_800_000).toISOString(), httpOnly: true, path: "/" },
      user: {
        sub: m.sub, username: m.username, displayName: m.displayName,
        loginAt: now - (o.loginAgoMs ?? 0), authTime: Math.floor(now / 1000),
        environment: o.environment ?? "TEST",
      },
    };
    store.set(sid, sess as never, () => undefined);
    const sig = createHmac("sha256", SECRET).update(sid).digest("base64").replace(/=+$/, "");
    return `${SESSION_COOKIE}=${encodeURIComponent(`s:${sid}.${sig}`)}`;
  }

  return { app, services, idp, accounts, store, loginAs };
}
