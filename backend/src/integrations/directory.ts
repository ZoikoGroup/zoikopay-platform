import { z } from "zod";
import { MERCHANT_PERSONAS, type Persona } from "../authorization/permissions.js";
import type { Membership, SessionUser } from "../authorization/principal.js";
import type { ConsoleDataSource } from "../database/dataSource.js";
import type { Environment } from "../types/domain.js";
import { AppError, errors } from "../types/errors.js";
import type { IdentityProvider } from "./oidc.js";

/**
 * Membership directory: who may do what, where.
 *
 * Roles and scope come only from Zoiko Pay's own grants in merchant.memberships
 * (BC-01), read through the Go gateway's GET /v1/principal with the signed-in
 * user's own access token, never from the token's claims, request headers or
 * user metadata (03-05 §11.2; OPEN_QUESTIONS Q36, Q39). Deny by default: no
 * live grant means no access.
 */
export interface MembershipDirectory {
  /**
   * The signed-in caller's grants, read fresh for this request: nothing is
   * cached, so a revoked grant stops working on the next request (36.19).
   * Throws AppError 503 MEMBERSHIP_UNAVAILABLE when they cannot be read, and
   * 401 SESSION_EXPIRED when the identity provider no longer accepts the session.
   */
  current(user: SessionUser): Promise<Membership | undefined>;
  /**
   * Another person's grants, for checks such as "does the requester still hold
   * the role". Unknown means no grant.
   */
  find(sub: string): Membership | undefined;
  /** Every grant, for counts on the Super Admin page. */
  all(): Membership[];
}

const TENANT_ID = /^ten_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const MERCHANT_ID = /^mer_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const WIRE_PERSONAS = ["mown", "mops", "mfin", "mdev", "mview"] as const;

/** GET /v1/principal, api/openapi/public.v1.yaml. Anything else is refused. */
const principalBody = z.strictObject({
  object: z.literal("principal"),
  issuer: z.string().min(1),
  subject: z.string().min(1),
  environment: z.enum(["test", "live"]),
  grants: z.array(z.strictObject({
    tenant_id: z.string().regex(TENANT_ID),
    merchant_id: z.string().regex(MERCHANT_ID).optional(),
    persona: z.enum(WIRE_PERSONAS),
    effective_from: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
  })).max(500),
});
type WireGrant = z.infer<typeof principalBody>["grants"][number];

/** Refresh the access token when it has less than this left. */
const REFRESH_MARGIN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 3_000;

const unavailable = (why: string) => new AppError(503, "MEMBERSHIP_UNAVAILABLE", "Access cannot be checked right now",
  "Your roles could not be read from Zoiko Pay, so nothing is shown. Try again shortly.", undefined, why);

export interface GatewayDirectoryOptions {
  /** Gateway base URL, without /v1. */
  baseUrl: string;
  /** The identity issuer the console signs in with; the gateway must report the same. */
  issuer: string;
  idp: Pick<IdentityProvider, "refresh">;
  /** Fixture merchants: the legal entity of a covered merchant comes from its own record (39.2). */
  data: Pick<ConsoleDataSource, "merchants">;
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Reads the caller's grants from the Go gateway on every request.
 *
 * One active grant per request (39.5): the first live grant in a fixed order
 * (tenant, then tenant-wide before merchant, then merchant, then persona).
 * Grants are never merged, so a persona held on one merchant can never apply
 * to another. Staff personas do not exist in merchant.memberships, so staff
 * get nothing (36.1, 39.3).
 */
export class GatewayDirectory implements MembershipDirectory {
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(private readonly o: GatewayDirectoryOptions) {
    this.now = o.now ?? Date.now;
    this.fetch = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.url = `${o.baseUrl.replace(/\/$/, "")}/v1/principal`;
  }

  async current(user: SessionUser): Promise<Membership | undefined> {
    let token = user.accessToken && (user.accessTokenExpiresAt ?? 0) - this.now() >= REFRESH_MARGIN_MS
      ? user.accessToken : await this.refresh(user);
    let res = await this.call(token);
    if (res.status === 401) {
      // The gateway no longer accepts this token: refresh once, then give up.
      token = await this.refresh(user);
      res = await this.call(token);
      if (res.status === 401) throw errors.sessionExpired();
    }
    // 403: the gateway refused the principal itself (grants in both TEST and LIVE, 36.16).
    if (res.status === 403) return undefined;
    if (res.status !== 200) throw unavailable(`gateway answered ${res.status}`);
    const parsed = principalBody.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw unavailable("gateway answer does not match the Principal schema");
    const p = parsed.data;
    // The gateway verified the token; it must be this user's, from our issuer.
    if (p.issuer !== this.o.issuer || p.subject !== user.sub) throw unavailable("gateway answered for another identity");

    const now = this.now();
    const live = p.grants
      .filter((g) => Date.parse(g.effective_from) <= now && now < Date.parse(g.expires_at)) // checked again with our clock
      .sort(grantOrder);
    const active = live[0];
    if (!active) return undefined;
    return this.membership(user, active, p.environment === "live" ? "LIVE" : "TEST");
  }

  /** The gateway answers only for the token's own subject; other people are unknown here. */
  find(): Membership | undefined {
    return undefined;
  }

  all(): Membership[] {
    return [];
  }

  private membership(user: SessionUser, g: WireGrant, env: Environment): Membership {
    let merchants: ReturnType<ConsoleDataSource["merchants"]>;
    try {
      merchants = this.o.data.merchants(env);
    } catch {
      merchants = []; // LIVE has no data source: nothing is covered
    }
    const covered = merchants.filter((m) => m.tenantId === g.tenant_id && (!g.merchant_id || m.id === g.merchant_id));
    const persona = g.persona.toUpperCase() as Persona;
    if (!MERCHANT_PERSONAS.includes(persona)) throw unavailable("not a merchant persona");
    return {
      sub: user.sub, username: user.username, displayName: user.displayName, personas: [persona],
      scope: {
        kind: "merchant",
        // 39.2 (narrows 36.17): only the legal entities of the merchants this grant already covers.
        legalEntityIds: [...new Set(covered.map((m) => m.legalEntityId))].sort(),
        tenantIds: [g.tenant_id],
        merchantIds: g.merchant_id ? [g.merchant_id] : "*", // "*": every merchant of this one tenant
        environments: [env],
      },
    };
  }

  private async call(token: string): Promise<Response> {
    try {
      return await this.fetch(this.url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw unavailable("gateway unreachable");
    }
  }

  /** Renews the session's access token in the server-side session and returns it. */
  private async refresh(user: SessionUser): Promise<string> {
    if (!user.refreshToken) throw errors.sessionExpired();
    const t = await this.o.idp.refresh(user.refreshToken);
    user.accessToken = t.accessToken;
    user.accessTokenExpiresAt = t.accessTokenExpiresAt;
    if (t.refreshToken) user.refreshToken = t.refreshToken;
    return t.accessToken;
  }
}

function grantOrder(a: WireGrant, b: WireGrant): number {
  return a.tenant_id.localeCompare(b.tenant_id)
    || (a.merchant_id ?? "").localeCompare(b.merchant_id ?? "")
    || a.persona.localeCompare(b.persona);
}
