import type { Config } from "../config.js";
import { AppError } from "../types/errors.js";

/**
 * Account administration in Zoiko iD (Keycloak locally): create an account and
 * set a password. Used by the sign-in page's "Create account" and "Change
 * password". Creating an account gives NO access: Zoiko Pay decides roles and
 * scope separately (03-05 §11.2), so a new account sees "No access assigned"
 * until an administrator grants a role.
 */
export interface Account {
  sub: string;
  username: string;
  displayName: string;
  enabled: boolean;
}

export interface AccountAdmin {
  /** Every person account (service accounts excluded). Used by the Access screen for IAM and Security only. */
  listAccounts(): Promise<Account[]>;
  /** One account by exact username, or undefined. */
  findAccount(username: string): Promise<Account | undefined>;
  createAccount(input: { username: string; firstName: string; lastName: string; email: string; password: string }): Promise<void>;
  setPassword(username: string, password: string): Promise<void>;
}

interface KeycloakUser { id: string; username: string; firstName?: string; lastName?: string; enabled?: boolean }

/** Keycloak Admin REST API through a service account with manage-users, view-users and query-users only. */
export class KeycloakAccountAdmin implements AccountAdmin {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly cfg: Config) {}

  private adminBase(): string {
    return this.cfg.oidc.issuer.replace("/realms/", "/admin/realms/");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 10_000) return this.token.value;
    const res = await fetch(`${this.cfg.oidc.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.accountAdmin.clientId, client_secret: this.cfg.accountAdmin.clientSecret }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res?.ok) throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Account service unavailable", "Could not reach the identity provider.");
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.adminBase()}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Account service unavailable");
    return res;
  }

  /** Keycloak rejects passwords that break the realm policy with 400 invalidPasswordMessage. */
  private async policyError(res: Response): Promise<AppError> {
    const body = (await res.json().catch(() => ({}))) as { error?: string; errorMessage?: string; error_description?: string };
    const msg = body.errorMessage ?? body.error_description ?? body.error ?? "";
    if (/password/i.test(msg)) {
      return new AppError(400, "WEAK_PASSWORD", "Password does not meet the policy",
        "Use at least 8 characters with an upper-case letter, a lower-case letter, a digit and a symbol, and not your username.");
    }
    return new AppError(400, "VALIDATION_FAILED", "The identity provider refused the request", msg || undefined);
  }

  private static toAccount(u: KeycloakUser): Account {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
    return { sub: u.id, username: u.username, displayName: name || u.username, enabled: u.enabled !== false };
  }

  async listAccounts(): Promise<Account[]> {
    const res = await this.call("GET", "/users?briefRepresentation=true&max=500");
    if (!res.ok) throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Account service unavailable");
    const users = (await res.json()) as KeycloakUser[];
    return users.filter((u) => !u.username.startsWith("service-account-")).map(KeycloakAccountAdmin.toAccount);
  }

  async findAccount(username: string): Promise<Account | undefined> {
    const res = await this.call("GET", `/users?exact=true&briefRepresentation=true&username=${encodeURIComponent(username)}`);
    if (!res.ok) throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Account service unavailable");
    const u = ((await res.json()) as KeycloakUser[]).find((x) => x.username === username.toLowerCase());
    return u && !u.username.startsWith("service-account-") ? KeycloakAccountAdmin.toAccount(u) : undefined;
  }

  async createAccount(i: { username: string; firstName: string; lastName: string; email: string; password: string }): Promise<void> {
    const res = await this.call("POST", "/users", {
      username: i.username, email: i.email, firstName: i.firstName, lastName: i.lastName, enabled: true, emailVerified: true,
      credentials: [{ type: "password", value: i.password, temporary: false }],
    });
    if (res.status === 201) return;
    if (res.status === 409) throw new AppError(409, "USERNAME_TAKEN", "That username or email is not available");
    throw await this.policyError(res);
  }

  async setPassword(username: string, password: string): Promise<void> {
    const find = await this.call("GET", `/users?exact=true&username=${encodeURIComponent(username)}`);
    const users = find.ok ? ((await find.json()) as { id: string }[]) : [];
    const id = users[0]?.id;
    if (!id) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid username or password");
    const res = await this.call("PUT", `/users/${id}/reset-password`, { type: "password", value: password, temporary: false });
    if (res.status === 204) return;
    throw await this.policyError(res);
  }
}
