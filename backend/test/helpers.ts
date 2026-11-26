import { createHmac, randomUUID } from "node:crypto";
import { MemoryStore } from "express-session";
import { pino, type Logger } from "pino";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import type { Environment } from "../src/types/domain.js";
import type { Config } from "../src/config.js";
import type { Account } from "../src/integrations/accounts.js";
import type { MembershipDirectory } from "../src/integrations/directory.js";
import type { IdentityClaims, IdentityProvider, TokenSet } from "../src/integrations/oidc.js";
import { HealthMonitor } from "../src/services/health.js";
import { AppError } from "../src/types/errors.js";
import { LOCAL_USERS, TestDirectory } from "./memberships.js";

export const ORIGIN = "http://localhost:5173";
export const PASSWORD = "Zoiko@123";
const SECRET = "test-only-session-secret-0123456789abcdef";
const TOKEN_TTL_MS = 5 * 60 * 1000;

export const testConfig: Config = {
  port: 0,
  production: false,
  logLevel: "silent",
  publicOrigin: ORIGIN,
  oidc: { issuer: "http://idp.test/realms/zoikopay", clientId: "zoikopay-console", clientSecret: "test" },
  accountAdmin: { clientId: "zoikopay-console-admin", clientSecret: "test" },
  sessionSecret: SECRET,
  goServices: [],
  gatewayUrl: "http://gateway.test",
  dataSource: "fixtures",
};

/** A fake access token for a user: opaque to the console, which never reads it. */
export const accessTokenFor = (username: string, n = 0) => `at-${username}-${n}`;

/** Accepts every local user with PASSWORD; records logouts and token refreshes. */
export class FakeIdp implements IdentityProvider {
  loggedOut: (string | undefined)[] = [];
  refreshed: string[] = [];
  /** Refresh tokens Keycloak no longer accepts (session ended or revoked). */
  deadRefreshTokens = new Set<string>();
  extraUsers = new Map<string, IdentityClaims>();
  private issued = 0;
  constructor(private readonly now: () => number = Date.now) {}

  async passwordLogin(username: string, password: string): Promise<IdentityClaims> {
    const extra = this.extraUsers.get(username);
    const u = LOCAL_USERS.find((x) => x.username === username);
    if (password !== PASSWORD || (!u && !extra)) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid username or password");
    return extra ?? {
      sub: u!.sub, username: u!.username, displayName: u!.displayName, authTime: Math.floor(this.now() / 1000),
      refreshToken: `rt-${username}`, accessToken: accessTokenFor(username), accessTokenExpiresAt: this.now() + TOKEN_TTL_MS,
    };
  }
  async refresh(refreshToken: string): Promise<TokenSet> {
    this.refreshed.push(refreshToken);
    if (this.deadRefreshTokens.has(refreshToken)) throw new AppError(401, "SESSION_EXPIRED", "Your session has expired");
    this.issued += 1;
    const username = refreshToken.replace(/^rt-/, "").replace(/#\d+$/, "");
    return { accessToken: accessTokenFor(username, this.issued), accessTokenExpiresAt: this.now() + TOKEN_TTL_MS, refreshToken: `rt-${username}#${this.issued}` };
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
    if (LOCAL_USERS.some((m) => m.username === i.username) || this.created.includes(i.username)) {
      throw new AppError(409, "USERNAME_TAKEN", "That username or email is not available");
    }
    this.created.push(i.username);
    this.extra.push({ sub: randomUUID(), username: i.username, displayName: `${i.firstName ?? ""} ${i.lastName ?? ""}`.trim() || i.username, enabled: true });
  }
  async listAccounts(): Promise<Account[]> {
    return [...LOCAL_USERS.map((m) => ({ ...m, enabled: true })), ...this.extra];
  }
  async findAccount(username: string): Promise<Account | undefined> {
    return (await this.listAccounts()).find((a) => a.username === username);
  }
  async setPassword(username: string, password: string) {
    this.passwords.set(username, password);
  }
}

export function makeTestApp<D extends MembershipDirectory = TestDirectory>(
  opts: { now?: () => number; config?: Partial<Config>; idp?: FakeIdp; log?: Logger; directory?: D } = {},
) {
  const store = new MemoryStore();
  const idp = opts.idp ?? new FakeIdp(opts.now);
  const config = { ...testConfig, ...opts.config };
  const accounts = new FakeAccounts();
  const log = opts.log ?? pino({ level: "silent" });
  const health = new HealthMonitor([], config.oidc.issuer, log);
  const directory = (opts.directory ?? new TestDirectory()) as D;
  const { app, services } = createApp({ config, log, idp, accounts, sessionStore: store, health, now: opts.now, directory });

  /** Creates a real server-side session for a local user and returns its signed cookie. */
  function loginAs(username: string, o: { environment?: Environment; loginAgoMs?: number; tokenExpiresInMs?: number } = {}): string {
    const u = LOCAL_USERS.find((x) => x.username === username);
    if (!u) throw new Error(`unknown test user ${username}`);
    const now = services.now();
    const sid = randomUUID();
    const sess = {
      cookie: { originalMaxAge: 1_800_000, expires: new Date(now + 1_800_000).toISOString(), httpOnly: true, path: "/" },
      user: {
        sub: u.sub, username: u.username, displayName: u.displayName,
        loginAt: now - (o.loginAgoMs ?? 0), authTime: Math.floor(now / 1000),
        refreshToken: `rt-${username}`, accessToken: accessTokenFor(username), accessTokenExpiresAt: now + (o.tokenExpiresInMs ?? TOKEN_TTL_MS),
        environment: o.environment ?? "TEST",
      },
    };
    store.set(sid, sess as never, () => undefined);
    const sig = createHmac("sha256", SECRET).update(sid).digest("base64").replace(/=+$/, "");
    return `${SESSION_COOKIE}=${encodeURIComponent(`s:${sid}.${sig}`)}`;
  }

  return { app, services, idp, accounts, store, loginAs, directory };
}
