import { testConfig } from "./helpers.js";
import { LOCAL_USERS } from "./memberships.js";

export type WirePersona = "mown" | "mops" | "mfin" | "mdev" | "mview";

export interface WireGrant {
  tenant_id: string;
  merchant_id?: string;
  persona: string;
  effective_from: string;
  expires_at: string;
}

/** A live grant as GET /v1/principal returns it (api/openapi/public.v1.yaml). */
export function wireGrant(tenant: string, merchant: string | undefined, persona: WirePersona,
  window: { from?: number; until?: number } = {}): WireGrant {
  const now = Date.now();
  return {
    tenant_id: tenant, ...(merchant ? { merchant_id: merchant } : {}), persona,
    effective_from: new Date(window.from ?? now - 3_600_000).toISOString(),
    expires_at: new Date(window.until ?? now + 48 * 3_600_000).toISOString(),
  };
}

/**
 * TEST-ONLY stand-in for the Go gateway's GET /v1/principal, used as the
 * console's `fetch`. Grants are keyed by subject; the caller is identified
 * only by the bearer token, like the real gateway.
 */
export class FakeGateway {
  calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  /** Grants per subject (the verified token's sub). */
  grants = new Map<string, WireGrant[]>();
  /** Tokens the gateway's verifier refuses (expired, revoked signing key …). */
  rejectedTokens = new Set<string>();
  down = false;
  /** Overrides the status, for 403/5xx cases. */
  status?: number;
  /** Rewrites the 200 body, for malformed-answer cases. */
  mutate?: (body: Record<string, unknown>) => Record<string, unknown>;

  set(username: string, grants: WireGrant[]): void {
    this.grants.set(subOf(username), grants);
  }
  /** Revokes every grant of a user: the next GET /v1/principal no longer lists them. */
  revokeAll(username: string): void {
    this.grants.set(subOf(username), []);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    this.calls.push({ url, method: init?.method ?? "GET", headers });
    if (this.down) throw new TypeError("fetch failed");
    const problem = (status: number, code: string) =>
      new Response(JSON.stringify({ status, code, title: code }), { status, headers: { "content-type": "application/problem+json" } });
    if (url !== `${testConfig.gatewayUrl}/v1/principal`) return problem(404, "resource_not_found");
    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    const user = LOCAL_USERS.find((u) => token.startsWith(`at-${u.username}-`));
    if (!user || this.rejectedTokens.has(token)) return problem(401, "authentication_required");
    if (this.status) return problem(this.status, this.status === 403 ? "permission_denied" : "temporarily_unavailable");
    let body: Record<string, unknown> = {
      object: "principal", issuer: testConfig.oidc.issuer, subject: user.sub, environment: "test",
      grants: this.grants.get(user.sub) ?? [],
    };
    if (this.mutate) body = this.mutate(body);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

export function subOf(username: string): string {
  const u = LOCAL_USERS.find((x) => x.username === username);
  if (!u) throw new Error(`unknown local user ${username}`);
  return u.sub;
}
