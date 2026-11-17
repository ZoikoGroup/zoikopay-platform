import { MERCHANT_PERSONAS, PERSONA_LABELS, PERSONAS, type Persona } from "../authorization/permissions.js";
import { hasPermission } from "../authorization/policy.js";
import type { Membership, Principal, Scope } from "../authorization/principal.js";
import type { Account, AccountAdmin } from "../integrations/accounts.js";
import type { MembershipDirectory } from "../integrations/directory.js";
import type { Environment } from "../types/domain.js";
import { AppError, errors } from "../types/errors.js";
import { auditActor, type CallContext, type Services } from "./context.js";
import { stepUpFresh } from "../screens/store.js";

/**
 * Role and delegation administration: 02-02 ZP-PER-WF-002, with the
 * permission register rows TENANT.ROLE.GRANT and TENANT.ROLE.REVOKE.
 *
 *  - A role is a grant: one persona, one scope, an optional expiry.
 *  - Granting is two-person: a requester (MOWN or PIAM) asks, an independent
 *    checker (MOWN or PIAM, not the requester, not the person receiving it)
 *    approves after re-entering their password. Nobody grants themselves.
 *  - "Never grant above delegator": merchant owners grant only merchant
 *    operations, finance, developer and viewer roles inside their own
 *    organisation; nobody grants Super Admin; environments and legal entities
 *    never exceed the delegator's own.
 *  - Revoke (MOWN, PIAM, PSEC) is effective on the person's next request,
 *    because every request re-reads the grant. Narrowing (an earlier expiry)
 *    is also immediate.
 *  - Each person holds at most one active role; an approved new grant
 *    replaces the old one. Every change raises the grant's version.
 *
 * Development limitation: grants live in process memory (like the audit log)
 * and reset when the backend restarts. Seeded grants mirror the local users.
 */

export type GrantStatus = "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "REVOKED" | "EXPIRED" | "REPLACED";

export interface GrantEvent {
  at: string;
  event: string;
  actor: string;
  note?: string;
}

export interface Grant {
  id: string;
  sub: string;
  username: string;
  displayName: string;
  persona: Persona;
  scope: Scope;
  expiresAt?: string;
  status: GrantStatus;
  version: number;
  requestedBySub: string;
  requestedByName: string;
  requestedAt: string;
  reason?: string;
  history: GrantEvent[];
}

export type AccessActionName = "approve" | "reject" | "revoke" | "narrow";

interface ActionRule {
  label: string;
  from: GrantStatus;
  deciders: readonly Persona[];
  stepUp: boolean;
  reasonRequired: boolean;
  /** The requester of the grant may not take this action (independent checker). */
  independent: boolean;
}

const ACTIONS: Record<AccessActionName, ActionRule> = {
  approve: { label: "Approve grant", from: "PENDING_APPROVAL", deciders: ["MOWN", "PIAM"], stepUp: true, reasonRequired: false, independent: true },
  reject: { label: "Reject request", from: "PENDING_APPROVAL", deciders: ["MOWN", "PIAM"], stepUp: false, reasonRequired: true, independent: true },
  revoke: { label: "Revoke role", from: "ACTIVE", deciders: ["MOWN", "PIAM", "PSEC"], stepUp: true, reasonRequired: true, independent: false },
  narrow: { label: "Set earlier expiry", from: "ACTIVE", deciders: ["MOWN", "PIAM"], stepUp: false, reasonRequired: true, independent: false },
};

/** Roles a merchant owner may delegate (below their own). */
const MOWN_DELEGABLE: readonly Persona[] = ["MOPS", "MFIN", "MDEV", "MVIEW"];
/** Roles that carry no data scope by default (02-02: support has no default cross-tenant search; SRE has no routine content access). */
const NO_DATA_SCOPE: readonly Persona[] = ["PSUP", "PSRE"];
const MAX_EXPIRY_DAYS = 365;

export interface RequestInput {
  username: string;
  persona: Persona;
  merchantIds?: string[];
  legalEntityIds?: string[];
  environments: Environment[];
  expiresAt?: string;
  reason: string;
}

export interface ActionInput {
  version: number;
  reason?: string;
  expiresAt?: string;
}

const isAdmin = (p: Principal) => p.personas.includes("PIAM") || p.personas.includes("PSEC");
const isOwner = (p: Principal) => p.personas.includes("MOWN");

export class AccessStore implements MembershipDirectory {
  private readonly grants: Grant[] = [];
  private seq = 0;

  constructor(seed: Membership[], private readonly now: () => number) {
    const at = new Date(now()).toISOString();
    for (const m of seed) {
      for (const persona of m.personas) {
        this.grants.push({
          id: this.nextId(), sub: m.sub, username: m.username, displayName: m.displayName, persona, scope: m.scope,
          status: "ACTIVE", version: 1, requestedBySub: "seed", requestedByName: "Local development setup", requestedAt: at,
          history: [{ at, event: "Granted by local development setup", actor: "System" }],
        });
      }
    }
  }

  private nextId(): string {
    this.seq += 1;
    return `grt_${String(this.seq).padStart(5, "0")}`;
  }

  /** Marks active grants past their expiry as EXPIRED. Called before every read. */
  private sweep(): void {
    const now = this.now();
    for (const g of this.grants) {
      if (g.status === "ACTIVE" && g.expiresAt && Date.parse(g.expiresAt) <= now) {
        g.status = "EXPIRED";
        g.version += 1;
        g.history.push({ at: g.expiresAt, event: "Expired", actor: "System" });
      }
    }
  }

  // --- MembershipDirectory: what authorization reads on every request ------

  find(sub: string): Membership | undefined {
    this.sweep();
    const g = this.grants.find((x) => x.sub === sub && x.status === "ACTIVE");
    return g ? { sub: g.sub, username: g.username, displayName: g.displayName, personas: [g.persona], scope: g.scope } : undefined;
  }

  all(): Membership[] {
    this.sweep();
    return this.grants.filter((g) => g.status === "ACTIVE")
      .map((g) => ({ sub: g.sub, username: g.username, displayName: g.displayName, personas: [g.persona], scope: g.scope }));
  }

  /** Raw grants, for tests. */
  allGrants(): readonly Grant[] {
    this.sweep();
    return this.grants;
  }

  // --- Visibility --------------------------------------------------------

  /**
   * Whether the caller may see and manage this grant. IAM and Security see
   * every grant. A merchant owner sees only merchant roles inside their own
   * organisation (tenant), never internal staff or other merchants.
   */
  private manages(p: Principal, g: Pick<Grant, "persona" | "scope">): boolean {
    if (isAdmin(p)) return true;
    if (!isOwner(p)) return false;
    const own = p.scope.tenantIds;
    if (g.scope.kind !== "merchant" || !MERCHANT_PERSONAS.includes(g.persona)) return false;
    if (own === "*" || g.scope.tenantIds === "*") return false;
    return g.scope.tenantIds.length > 0 && g.scope.tenantIds.every((t) => own.includes(t));
  }

  /** Why the caller may not act, or null. Same check for the UI hint and the real action. */
  private blocked(p: Principal, name: AccessActionName, g: Grant): AppError | null {
    const rule = ACTIONS[name];
    if (!rule.deciders.some((x) => p.personas.includes(x))) return new AppError(403, "FORBIDDEN", "Not permitted", "Your role cannot take this action.");
    if (g.status !== rule.from) return new AppError(409, "INVALID_STATE", "Action not available", `Not available while the grant is ${g.status.toLowerCase().replaceAll("_", " ")}.`);
    if (g.sub === p.sub) return new AppError(403, "SELF_GRANT_PROHIBITED", "This is your own access", "Another administrator must change your own role.");
    if (rule.independent && g.requestedBySub === p.sub) {
      return new AppError(403, "SELF_APPROVAL_PROHIBITED", "You requested this grant", "An independent administrator must decide it.");
    }
    if (isOwner(p) && !isAdmin(p) && !MOWN_DELEGABLE.includes(g.persona)) {
      return new AppError(403, "ROLE_EXCEEDS_DELEGATOR", "Not below your own role", "Merchant owners manage only operations, finance, developer and viewer roles.");
    }
    return null;
  }

  private actionsFor(p: Principal, g: Grant) {
    return (Object.keys(ACTIONS) as AccessActionName[]).map((name) => {
      const rule = ACTIONS[name];
      const why = this.blocked(p, name, g);
      return { name, label: rule.label, stepUp: rule.stepUp, reasonRequired: rule.reasonRequired, allowed: why === null,
        ...(why ? { blockedReason: why.detail ?? why.title } : {}) };
    }).filter((a) => ACTIONS[a.name].from === g.status && ACTIONS[a.name].deciders.some((x) => p.personas.includes(x)));
  }

  private grantView(p: Principal, g: Grant) {
    return {
      id: g.id, persona: g.persona, role: PERSONA_LABELS[g.persona], status: g.status, version: g.version,
      scope: scopeView(g.scope), expiresAt: g.expiresAt ?? null,
      requestedByName: g.requestedBySub === p.sub ? "You" : g.requestedByName, requestedAt: g.requestedAt,
      isOwnRequest: g.requestedBySub === p.sub, reason: g.reason ?? null, history: g.history,
      actions: this.actionsFor(p, g),
    };
  }

  private requireArea(s: Services, ctx: CallContext, action: string): void {
    if (!hasPermission(ctx.principal, "area.access")) {
      s.audit.append({ ...auditActor(ctx), action, outcome: "DENIED" });
      throw errors.forbidden();
    }
  }

  // --- Reads -------------------------------------------------------------

  /**
   * People and their roles. IAM and Security also see accounts with no role
   * (from Zoiko iD), so new sign-ups can be given one. Merchant owners see
   * only their own organisation's people (no account enumeration).
   */
  async listMembers(s: Services, ctx: CallContext, accounts: AccountAdmin, q: { q?: string; status?: string }) {
    this.requireArea(s, ctx, "access.members.list");
    this.sweep();
    const p = ctx.principal;
    const people = new Map<string, { sub: string; username: string; displayName: string; grants: Grant[] }>();
    for (const g of this.grants) {
      if (!this.manages(p, g)) continue;
      const row = people.get(g.sub) ?? { sub: g.sub, username: g.username, displayName: g.displayName, grants: [] };
      row.grants.push(g);
      people.set(g.sub, row);
    }
    let accountsUnavailable = false;
    if (isAdmin(p)) {
      try {
        for (const a of await accounts.listAccounts()) {
          if (!people.has(a.sub) && !this.grants.some((g) => g.sub === a.sub)) people.set(a.sub, { sub: a.sub, username: a.username, displayName: a.displayName, grants: [] });
        }
      } catch {
        accountsUnavailable = true;
      }
    }

    const rows = [...people.values()].map((m) => {
      const active = m.grants.find((g) => g.status === "ACTIVE");
      const pending = m.grants.find((g) => g.status === "PENDING_APPROVAL");
      const latest = m.grants.at(-1);
      const status = pending ? "PENDING_APPROVAL" : active ? "ACTIVE" : latest ? latest.status : "NO_ROLE";
      const shown = active ?? pending ?? latest;
      const next = [pending, active].flatMap((g) => (g ? this.actionsFor(p, g).filter((a) => a.allowed) : []))[0];
      return {
        sub: m.sub, username: m.username, displayName: m.displayName, isSelf: m.sub === p.sub, status,
        role: active ? PERSONA_LABELS[active.persona] : null,
        persona: active?.persona ?? null,
        requestedRole: pending ? PERSONA_LABELS[pending.persona] : null,
        scope: shown ? scopeView(shown.scope).summary : null,
        expiresAt: active?.expiresAt ?? null,
        grantedBy: active ? active.history.find((h) => h.event.startsWith("Approved"))?.actor ?? active.requestedByName : null,
        nextStep: next?.label ?? null,
      };
    }).sort((a, b) => a.username.localeCompare(b.username));

    const needle = q.q?.toLowerCase();
    const filtered = rows.filter((r) => (!q.status || r.status === q.status) &&
      (!needle || r.username.includes(needle) || r.displayName.toLowerCase().includes(needle) || (r.role ?? "").toLowerCase().includes(needle)));
    const count = (st: string) => rows.filter((r) => r.status === st).length;
    return {
      summary: [
        { label: "People", value: String(rows.length) },
        { label: "Active roles", value: String(count("ACTIVE")) },
        { label: "Waiting for approval", value: String(count("PENDING_APPROVAL")) },
        { label: "No role", value: String(count("NO_ROLE")) },
      ],
      statuses: [...new Set(rows.map((r) => r.status))].sort(),
      accountsUnavailable,
      canRequest: isOwner(p) || p.personas.includes("PIAM"),
      total: filtered.length,
      items: filtered,
    };
  }

  member(s: Services, ctx: CallContext, sub: string, account?: Account) {
    this.requireArea(s, ctx, "access.members.read");
    this.sweep();
    const p = ctx.principal;
    const grants = this.grants.filter((g) => g.sub === sub && this.manages(p, g));
    if (!grants.length && !(isAdmin(p) && account)) {
      s.audit.append({ ...auditActor(ctx), action: "access.members.read", outcome: "DENIED", resource: { type: "person", id: sub } });
      throw errors.notFound("Person");
    }
    const first = grants[0];
    return {
      sub, username: first?.username ?? account?.username ?? "", displayName: first?.displayName ?? account?.displayName ?? "",
      isSelf: sub === p.sub,
      grants: [...grants].reverse().map((g) => this.grantView(p, g)),
    };
  }

  /** What the caller may request: roles below their own and scopes inside their own. */
  requestOptions(s: Services, ctx: CallContext) {
    this.requireArea(s, ctx, "access.options");
    const p = ctx.principal;
    const roles = this.requestableRoles(p).map((x) => ({ persona: x, label: PERSONA_LABELS[x], kind: MERCHANT_PERSONAS.includes(x) ? "merchant" : "internal" }));
    const merchants = this.merchantsInScope(s, p).map((m) => ({ id: m.id, displayName: m.displayName, legalEntityId: m.legalEntityId }));
    const legalEntities = s.data.legalEntities().filter((e) => p.scope.legalEntityIds.includes(e.id)).map((e) => ({ id: e.id, name: e.name }));
    return { roles, merchants, legalEntities, environments: p.scope.environments, allMerchantsOption: isOwner(p) && !p.personas.includes("PIAM"), maxExpiryDays: MAX_EXPIRY_DAYS };
  }

  private requestableRoles(p: Principal): Persona[] {
    if (p.personas.includes("PIAM")) return PERSONAS.filter((x) => x !== "SUPER_ADMIN");
    if (isOwner(p)) return [...MOWN_DELEGABLE];
    return [];
  }

  private merchantsInScope(s: Services, p: Principal) {
    const sc = p.scope;
    return s.data.merchants("TEST").filter((m) => sc.legalEntityIds.includes(m.legalEntityId) &&
      (sc.tenantIds === "*" || sc.tenantIds.includes(m.tenantId)) && (sc.merchantIds === "*" || sc.merchantIds.includes(m.id)));
  }

  /** Grants waiting for the caller's decision (notification bell). */
  actionable(ctx: CallContext): { sub: string; label: string; at: string }[] {
    if (!hasPermission(ctx.principal, "area.access")) return [];
    this.sweep();
    return this.grants
      .filter((g) => g.status === "PENDING_APPROVAL" && this.manages(ctx.principal, g) && this.blocked(ctx.principal, "approve", g) === null)
      .map((g) => ({ sub: g.sub, label: `Access: approve ${PERSONA_LABELS[g.persona]} for ${g.displayName}`, at: g.requestedAt }));
  }

  // --- Writes ------------------------------------------------------------

  async request(s: Services, ctx: CallContext, accounts: AccountAdmin, input: RequestInput) {
    const p = ctx.principal;
    const audit = "access.grant.request";
    const deny = (err: AppError): never => {
      s.audit.append({ ...auditActor(ctx), action: audit, outcome: "DENIED", detail: { code: err.code, persona: input.persona } });
      throw err;
    };
    this.requireArea(s, ctx, audit);
    if (!this.requestableRoles(p).length) deny(new AppError(403, "FORBIDDEN", "Not permitted", "Your role cannot request roles for others."));
    if (input.persona === "SUPER_ADMIN") deny(new AppError(403, "ROLE_EXCEEDS_DELEGATOR", "Super Admin cannot be granted here", "Super Admin is assigned outside the console."));
    if (!this.requestableRoles(p).includes(input.persona)) {
      deny(new AppError(403, "ROLE_EXCEEDS_DELEGATOR", "Above your own role", "You can grant only roles below your own."));
    }

    const account = await accounts.findAccount(input.username);
    if (!account || !account.enabled) return deny(new AppError(404, "NOT_FOUND", "No account with that username", "Ask the person to create an account on the sign-in page first."));
    if (account.sub === p.sub) deny(new AppError(403, "SELF_GRANT_PROHIBITED", "You cannot grant yourself a role", "Another administrator must change your own access."));

    this.sweep();
    if (this.grants.some((g) => g.sub === account.sub && g.status === "PENDING_APPROVAL")) {
      deny(new AppError(409, "INVALID_STATE", "A request is already waiting", "Approve or reject the existing request first."));
    }
    const active = this.grants.find((g) => g.sub === account.sub && g.status === "ACTIVE");
    // A merchant owner may not take over someone who belongs elsewhere. Same
    // answer whatever the reason, so other organisations are not revealed.
    if (active && !this.manages(p, active)) deny(new AppError(403, "FORBIDDEN", "This person cannot be added", "Ask an IAM administrator for help."));

    const scope = this.buildScope(s, p, input, deny);
    let expiresAt: string | undefined;
    if (input.expiresAt) expiresAt = this.checkExpiry(input.expiresAt, undefined, deny);

    const at = new Date(this.now()).toISOString();
    const g: Grant = {
      id: this.nextId(), sub: account.sub, username: account.username, displayName: account.displayName, persona: input.persona,
      scope, ...(expiresAt ? { expiresAt } : {}), status: "PENDING_APPROVAL", version: 1,
      requestedBySub: p.sub, requestedByName: p.displayName, requestedAt: at, reason: input.reason.trim(),
      history: [{ at, event: `Requested ${PERSONA_LABELS[input.persona]}`, actor: p.displayName, note: input.reason.trim() }],
    };
    if (!this.manages(p, g)) deny(new AppError(403, "FORBIDDEN", "Outside your organisation", "You can grant roles only inside your own organisation."));
    this.grants.push(g);
    s.audit.append({ ...auditActor(ctx), action: audit, outcome: "SUCCEEDED", resource: { type: "grant", id: g.id },
      detail: { persona: g.persona, target: account.username, scope: scopeView(scope).summary } });
    return this.member(s, ctx, account.sub);
  }

  /** Builds a scope no wider than the requester's own. */
  private buildScope(s: Services, p: Principal, input: RequestInput, deny: (e: AppError) => never): Scope {
    const envs = [...new Set(input.environments)];
    if (!envs.length || envs.some((e) => !p.scope.environments.includes(e))) {
      deny(new AppError(403, "ROLE_EXCEEDS_DELEGATOR", "Environment outside your own access", `You can grant only ${p.scope.environments.join(" and ")}.`));
    }
    if (MERCHANT_PERSONAS.includes(input.persona)) {
      const mine = this.merchantsInScope(s, p);
      const ids = input.merchantIds ?? [];
      if (ids.length === 1 && ids[0] === "*") {
        // "All merchants in my organisation": only for a merchant owner, bounded by their tenants.
        if (!isOwner(p) || p.scope.tenantIds === "*") deny(new AppError(400, "VALIDATION_FAILED", "Choose specific merchants"));
        const tenants = p.scope.tenantIds as string[];
        return { kind: "merchant", legalEntityIds: [...p.scope.legalEntityIds], tenantIds: [...tenants], merchantIds: "*", environments: envs };
      }
      if (!ids.length) deny(new AppError(400, "VALIDATION_FAILED", "Choose at least one merchant"));
      const chosen = ids.map((id) => mine.find((m) => m.id === id));
      if (chosen.some((m) => !m)) deny(new AppError(403, "FORBIDDEN", "Merchant outside your scope", "Choose merchants you can see."));
      const ms = chosen.filter((m): m is NonNullable<typeof m> => !!m);
      const tenants = [...new Set(ms.map((m) => m.tenantId))];
      if (tenants.length > 1) deny(new AppError(400, "VALIDATION_FAILED", "Merchants from one organisation only", "A merchant role covers one organisation."));
      return { kind: "merchant", legalEntityIds: [...new Set(ms.map((m) => m.legalEntityId))], tenantIds: tenants, merchantIds: ms.map((m) => m.id), environments: envs };
    }
    if (NO_DATA_SCOPE.includes(input.persona)) {
      return { kind: "internal", legalEntityIds: [], tenantIds: [], merchantIds: [], environments: envs };
    }
    const les = [...new Set(input.legalEntityIds ?? [])];
    if (!les.length) deny(new AppError(400, "VALIDATION_FAILED", "Choose at least one legal entity"));
    if (les.some((e) => !p.scope.legalEntityIds.includes(e))) deny(new AppError(403, "ROLE_EXCEEDS_DELEGATOR", "Legal entity outside your own access"));
    return { kind: "internal", legalEntityIds: les, tenantIds: "*", merchantIds: "*", environments: envs };
  }

  private checkExpiry(value: string, current: string | undefined, deny: (e: AppError) => never): string {
    const t = Date.parse(value);
    const now = this.now();
    if (Number.isNaN(t) || t <= now) deny(new AppError(400, "VALIDATION_FAILED", "Expiry must be in the future"));
    if (t > now + MAX_EXPIRY_DAYS * 86_400_000) deny(new AppError(400, "VALIDATION_FAILED", `Expiry must be within ${MAX_EXPIRY_DAYS} days`));
    if (current && t >= Date.parse(current)) deny(new AppError(400, "VALIDATION_FAILED", "Expiry can only move earlier", "Narrowing never extends access."));
    return new Date(t).toISOString();
  }

  act(s: Services, ctx: CallContext, grantId: string, name: AccessActionName, input: ActionInput) {
    const p = ctx.principal;
    const audit = `access.grant.${name}`;
    const deny = (err: AppError): never => {
      s.audit.append({ ...auditActor(ctx), action: audit, outcome: "DENIED", resource: { type: "grant", id: grantId }, detail: { code: err.code } });
      throw err;
    };
    this.requireArea(s, ctx, audit);
    this.sweep();
    const g = this.grants.find((x) => x.id === grantId);
    if (!g || !this.manages(p, g)) return deny(errors.notFound("Grant"));
    const rule = ACTIONS[name];
    const why = this.blocked(p, name, g);
    if (why) deny(why);
    if (g.version !== input.version) deny(new AppError(409, "STALE_VERSION", "This grant changed since you opened it", "Reload it and review again."));
    const reason = input.reason?.trim() ?? "";
    if (rule.reasonRequired && reason.length < 10) deny(new AppError(400, "VALIDATION_FAILED", "A reason is required", "Write at least 10 characters."));
    if (rule.stepUp && !stepUpFresh(p, s.now())) {
      deny(new AppError(401, "STEP_UP_REQUIRED", "Confirm your password", "This action needs your password again within the last 5 minutes."));
    }

    const at = new Date(this.now()).toISOString();
    const note = reason ? { note: reason } : {};
    if (name === "approve") {
      for (const old of this.grants) {
        if (old.sub === g.sub && old.status === "ACTIVE") {
          old.status = "REPLACED";
          old.version += 1;
          old.history.push({ at, event: `Replaced by ${PERSONA_LABELS[g.persona]} (${g.id})`, actor: p.displayName });
        }
      }
      g.status = "ACTIVE";
      g.history.push({ at, event: "Approved", actor: p.displayName, ...note });
    } else if (name === "reject") {
      g.status = "REJECTED";
      g.history.push({ at, event: "Rejected", actor: p.displayName, ...note });
    } else if (name === "revoke") {
      g.status = "REVOKED";
      g.history.push({ at, event: "Revoked (effective immediately)", actor: p.displayName, ...note });
    } else {
      if (!input.expiresAt) deny(new AppError(400, "VALIDATION_FAILED", "Choose the new expiry date"));
      g.expiresAt = this.checkExpiry(input.expiresAt ?? "", g.expiresAt, deny);
      g.history.push({ at, event: `Expiry set to ${g.expiresAt.slice(0, 10)}`, actor: p.displayName, ...note });
    }
    g.version += 1;
    s.audit.append({ ...auditActor(ctx), action: audit, outcome: "SUCCEEDED", resource: { type: "grant", id: g.id },
      detail: { persona: g.persona, target: g.username, to: g.status, version: input.version, stepUp: rule.stepUp } });
    return this.member(s, ctx, g.sub);
  }
}

function scopeView(sc: Scope) {
  const list = (v: string[] | "*", all: string) => (v === "*" ? all : v.length ? v.join(", ") : "none");
  const parts = sc.kind === "merchant"
    ? [`Organisation ${list(sc.tenantIds, "all")}`, `merchants ${list(sc.merchantIds, "all in organisation")}`]
    : sc.legalEntityIds.length ? [`legal entities ${sc.legalEntityIds.join(", ")}`] : ["no data scope"];
  return {
    kind: sc.kind, legalEntityIds: sc.legalEntityIds, tenantIds: sc.tenantIds, merchantIds: sc.merchantIds, environments: sc.environments,
    summary: `${parts.join("; ")} · ${sc.environments.join(" + ")}`,
  };
}
