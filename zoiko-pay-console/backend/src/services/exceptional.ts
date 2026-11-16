import type { Persona } from "../authorization/permissions.js";
import { hasPermission } from "../authorization/policy.js";
import type { Principal } from "../authorization/principal.js";
import { stepUpFresh } from "../screens/store.js";
import type { Payment } from "../types/domain.js";
import { AppError, errors } from "../types/errors.js";
import { auditActor, type CallContext, type Services } from "./context.js";
import { maskEmail } from "./payments.js";

/**
 * Exceptional access (ADR 0004; 03-05 §10.2; 02-02 WF-007 and WF-011).
 *
 * Console demo of the workflow. A grant never changes the person's role: it
 * opens one read-only, masked window onto named merchants' payments for a
 * limited time, reachable only through /exceptional-access/:id/payments.
 *
 *  support    requested by Support (PSUP) for a support ticket
 *  breakglass requested by SRE (PSRE) for an incident
 *  Both are approved by Security (PSEC): never the requester, with a fresh
 *  password. Reviewed afterwards by Security who is neither approver nor
 *  grantee. Super Admin cannot request or approve (Q19); it sees counts.
 *
 * Development limitation: in memory, reset on restart. The production home is
 * BC-08 governance (Go), with Temporal timers (ADR 0004 §2.8).
 */

export type Kind = "support" | "breakglass";
export type XaStatus = "REQUESTED" | "ACTIVE" | "REJECTED" | "LAPSED" | "EXPIRED" | "REVOKED" | "CLOSED";
export type XaAction = "approve" | "reject" | "revoke" | "close" | "review";
export const UNMASKABLE = ["customer_email", "card_details"] as const;
export type Unmaskable = (typeof UNMASKABLE)[number];

/** Proposed values pending OPEN_QUESTIONS Q20 and Q21. */
export const LIMITS = {
  maxMinutes: { support: 240, breakglass: 120 } as Record<Kind, number>,
  lapseMinutes: 30,
  reviewDueDays: 2,
  maxMerchants: 5,
};

const REQUESTER: Record<Kind, Persona> = { support: "PSUP", breakglass: "PSRE" };
const APPROVER: Persona = "PSEC";
const ENDED: readonly XaStatus[] = ["EXPIRED", "REVOKED", "CLOSED"];
const MIN = 60_000;

interface Event { at: string; event: string; actor: string; note?: string }

export interface Grant {
  id: string;
  kind: Kind;
  ticketId: string;
  consentRef?: string;
  purpose: string;
  environment: "TEST";
  legalEntityId: string;
  tenantId: string;
  merchantIds: string[];
  unmasked: Unmaskable[];
  durationMinutes: number;
  requestedBySub: string;
  requestedByName: string;
  requestedRole: Persona;
  requestedAt: string;
  approvedBySub?: string;
  approvedByName?: string;
  approvedAt?: string;
  expiresAt?: string;
  endedAt?: string;
  status: XaStatus;
  version: number;
  history: Event[];
  reads: { at: string; resource: string; fields: string[] }[];
  review?: { bySub: string; byName: string; outcome: "in_policy" | "escalate"; notes: string; at: string };
}

export interface RequestInput {
  kind: Kind;
  ticketId: string;
  consentRef?: string;
  purpose: string;
  merchantIds: string[];
  unmasked: Unmaskable[];
  durationMinutes: number;
}

export interface ActionInput {
  version: number;
  reason?: string;
  outcome?: "in_policy" | "escalate";
}

const holds = (p: Principal, x: Persona) => p.personas.includes(x);

export class ExceptionalAccessStore {
  private readonly grants: Grant[] = [];
  private seq = 0;

  constructor(private readonly now: () => number) {}

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  /**
   * Time and role checks, run before every read and action: requests lapse,
   * grants expire, and a grant closes if its holder no longer has the role
   * they requested it with (03-05 §10.2 "role change").
   */
  private sweep(s: Services): void {
    const now = this.now();
    for (const g of this.grants) {
      if (g.status === "REQUESTED" && now - Date.parse(g.requestedAt) >= LIMITS.lapseMinutes * MIN) {
        this.end(g, "LAPSED", "Lapsed: nobody approved within 30 minutes", "System", Date.parse(g.requestedAt) + LIMITS.lapseMinutes * MIN);
      } else if (g.status === "ACTIVE" && g.expiresAt && now >= Date.parse(g.expiresAt)) {
        this.end(g, "EXPIRED", "Expired", "System", Date.parse(g.expiresAt));
      } else if ((g.status === "ACTIVE" || g.status === "REQUESTED") && !s.directory.find(g.requestedBySub)?.personas.includes(g.requestedRole)) {
        this.end(g, "CLOSED", "Closed: the holder's role changed", "System", now);
      }
    }
  }

  private end(g: Grant, to: XaStatus, event: string, actor: string, atMs: number, note?: string): void {
    g.status = to;
    g.version += 1;
    if (ENDED.includes(to)) g.endedAt = this.iso(atMs);
    g.history.push({ at: this.iso(atMs), event, actor, ...(note ? { note } : {}) });
  }

  private reviewDue(g: Grant): boolean {
    return ENDED.includes(g.status) && !!g.approvedAt && !g.review;
  }

  private reviewOverdue(g: Grant): boolean {
    return this.reviewDue(g) && !!g.endedAt && this.now() - Date.parse(g.endedAt) > LIMITS.reviewDueDays * 24 * 60 * MIN;
  }

  /** Security sees every grant; Support and SRE see only their own. */
  private visible(p: Principal, g: Grant): boolean {
    return holds(p, APPROVER) || g.requestedBySub === p.sub;
  }

  private blocked(p: Principal, name: XaAction, g: Grant): AppError | null {
    const no = (detail: string) => new AppError(403, "FORBIDDEN", "Not permitted", detail);
    const state = (detail: string) => new AppError(409, "INVALID_STATE", "Action not available", detail);
    switch (name) {
      case "approve":
      case "reject":
        if (!holds(p, APPROVER)) return no("Only Security approves exceptional access.");
        if (g.status !== "REQUESTED") return state(`The request is ${g.status.toLowerCase()}.`);
        if (g.requestedBySub === p.sub) return new AppError(403, "SELF_APPROVAL_PROHIBITED", "You requested this access", "A different person must decide it.");
        return null;
      case "revoke":
        if (!holds(p, APPROVER) && g.requestedBySub !== p.sub) return no("Only Security or the holder can revoke.");
        if (g.status !== "ACTIVE") return state(`The grant is ${g.status.toLowerCase()}.`);
        return null;
      case "close":
        if (g.requestedBySub !== p.sub) return no("Only the holder closes their access when the work is done.");
        if (g.status !== "ACTIVE") return state(`The grant is ${g.status.toLowerCase()}.`);
        return null;
      case "review":
        if (!holds(p, APPROVER)) return no("Only Security reviews exceptional access.");
        if (!this.reviewDue(g)) return state(g.review ? "Already reviewed." : "Review opens when the access has ended.");
        if (g.approvedBySub === p.sub) return new AppError(403, "SELF_APPROVAL_PROHIBITED", "You approved this access", "An independent reviewer must review it.");
        if (g.requestedBySub === p.sub) return new AppError(403, "SELF_APPROVAL_PROHIBITED", "This was your access", "An independent reviewer must review it.");
        return null;
    }
  }

  private static readonly RULES: Record<XaAction, { label: string; stepUp: boolean; reasonRequired: boolean }> = {
    approve: { label: "Approve access", stepUp: true, reasonRequired: false },
    reject: { label: "Reject", stepUp: false, reasonRequired: true },
    revoke: { label: "Revoke now", stepUp: false, reasonRequired: true },
    close: { label: "Close: work done", stepUp: false, reasonRequired: false },
    review: { label: "Record review", stepUp: true, reasonRequired: true },
  };

  private view(s: Services, p: Principal, g: Grant, detail: boolean) {
    const actions = (Object.keys(ExceptionalAccessStore.RULES) as XaAction[]).map((name) => {
      const why = this.blocked(p, name, g);
      return { name, ...ExceptionalAccessStore.RULES[name], allowed: why === null, ...(why ? { blockedReason: why.detail ?? why.title } : {}) };
    }).filter((a) => a.allowed || (a.name === "approve" && g.status === "REQUESTED" && holds(p, APPROVER)) || (a.name === "review" && this.reviewDue(g) && holds(p, APPROVER)));
    const merchants = s.data.merchants("TEST");
    return {
      id: g.id, kind: g.kind, ticketId: g.ticketId, consentRef: g.consentRef ?? null, purpose: g.purpose, status: g.status, version: g.version,
      scope: {
        environment: g.environment, legalEntityId: g.legalEntityId, tenantId: g.tenantId,
        merchants: g.merchantIds.map((id) => ({ id, name: merchants.find((m) => m.id === id)?.displayName ?? id })),
        resources: "Payments (read-only)", unmasked: g.unmasked,
      },
      durationMinutes: g.durationMinutes,
      requestedByName: g.requestedBySub === p.sub ? "You" : g.requestedByName, requestedRole: g.requestedRole, requestedAt: g.requestedAt,
      isMine: g.requestedBySub === p.sub,
      approvedByName: g.approvedBySub === p.sub ? "You" : g.approvedByName ?? null, approvedAt: g.approvedAt ?? null,
      expiresAt: g.expiresAt ?? null, endedAt: g.endedAt ?? null,
      reviewDue: this.reviewDue(g), reviewOverdue: this.reviewOverdue(g), review: g.review ? { ...g.review, bySub: undefined } : null,
      readCount: g.reads.length,
      actions,
      ...(detail ? { history: g.history, reads: holds(p, APPROVER) ? g.reads.slice(-100).reverse() : [] } : {}),
    };
  }

  private requireArea(s: Services, ctx: CallContext, action: string): void {
    if (!hasPermission(ctx.principal, "area.exceptional")) {
      s.audit.append({ ...auditActor(ctx), action, outcome: "DENIED" });
      throw errors.forbidden();
    }
  }

  // --- Reads --------------------------------------------------------------

  list(s: Services, ctx: CallContext, q: { status?: string }) {
    this.requireArea(s, ctx, "exceptional.list");
    this.sweep(s);
    const p = ctx.principal;
    const mine = this.grants.filter((g) => this.visible(p, g));
    const rows = mine.filter((g) => !q.status || (q.status === "REVIEW_DUE" ? this.reviewDue(g) : g.status === q.status))
      .slice().reverse().map((g) => this.view(s, p, g, false));
    return {
      canRequest: (["support", "breakglass"] as Kind[]).filter((k) => holds(p, REQUESTER[k])),
      isApprover: holds(p, APPROVER),
      summary: [
        { label: "Waiting for approval", value: String(mine.filter((g) => g.status === "REQUESTED").length) },
        { label: "Active now", value: String(mine.filter((g) => g.status === "ACTIVE").length) },
        { label: "Review due", value: String(mine.filter((g) => this.reviewDue(g)).length) },
        { label: "Total", value: String(mine.length) },
      ],
      items: rows,
    };
  }

  get(s: Services, ctx: CallContext, id: string) {
    this.requireArea(s, ctx, "exceptional.read");
    this.sweep(s);
    const g = this.grants.find((x) => x.id === id);
    if (!g || !this.visible(ctx.principal, g)) {
      s.audit.append({ ...auditActor(ctx), action: "exceptional.read", outcome: "DENIED", resource: { type: "exceptional_access", id } });
      throw errors.notFound("Access request");
    }
    return this.view(s, ctx.principal, g, true);
  }

  options(s: Services, ctx: CallContext) {
    this.requireArea(s, ctx, "exceptional.options");
    const p = ctx.principal;
    return {
      kinds: (["support", "breakglass"] as Kind[]).filter((k) => holds(p, REQUESTER[k]))
        .map((k) => ({ kind: k, label: k === "support" ? "Support ticket" : "Incident (break-glass)", maxMinutes: LIMITS.maxMinutes[k] })),
      // Organisation and merchant identifiers only, so a ticket can name its merchant.
      merchants: s.data.merchants("TEST").map((m) => ({ id: m.id, name: m.displayName, tenantId: m.tenantId, legalEntityId: m.legalEntityId })),
      unmaskable: UNMASKABLE,
      maxMerchants: LIMITS.maxMerchants,
    };
  }

  /** Counts for Super Admin's platform page. No ids, tickets or resources. */
  counts(s: Services) {
    this.sweep(s);
    return {
      waiting: this.grants.filter((g) => g.status === "REQUESTED").length,
      active: this.grants.filter((g) => g.status === "ACTIVE").length,
      reviewDue: this.grants.filter((g) => this.reviewDue(g)).length,
      reviewOverdue: this.grants.filter((g) => this.reviewOverdue(g)).length,
    };
  }

  /** Items for the notification bell: approvals and reviews for Security. */
  actionable(s: Services, ctx: CallContext): { id: string; label: string; at: string; screenId: string }[] {
    if (!hasPermission(ctx.principal, "area.exceptional")) return [];
    this.sweep(s);
    const p = ctx.principal;
    return this.grants.flatMap((g) => {
      const screenId = g.kind === "support" ? "ZP-PER-WF-007" : "ZP-PER-WF-011";
      if (this.blocked(p, "approve", g) === null) return [{ id: g.id, screenId, at: g.requestedAt, label: `Exceptional access: approve ${g.ticketId}` }];
      if (this.blocked(p, "review", g) === null) return [{ id: g.id, screenId, at: g.endedAt ?? g.requestedAt, label: `Exceptional access: review ${g.ticketId}` }];
      return [];
    });
  }

  // --- Writes -------------------------------------------------------------

  request(s: Services, ctx: CallContext, input: RequestInput) {
    const p = ctx.principal;
    const deny = (err: AppError): never => {
      s.audit.append({ ...auditActor(ctx), action: "exceptional.request", outcome: "DENIED", detail: { code: err.code, kind: input.kind } });
      throw err;
    };
    this.requireArea(s, ctx, "exceptional.request");
    this.sweep(s);
    const role = REQUESTER[input.kind];
    if (!holds(p, role)) {
      deny(new AppError(403, "FORBIDDEN", "Not permitted", input.kind === "support"
        ? "Only Support requests access for a support ticket." : "Only SRE requests break-glass access."));
    }
    if (input.durationMinutes > LIMITS.maxMinutes[input.kind]) {
      deny(new AppError(400, "VALIDATION_FAILED", "Too long", `At most ${LIMITS.maxMinutes[input.kind]} minutes. Request again later if needed.`));
    }
    if (this.grants.some((g) => g.requestedBySub === p.sub && (g.status === "REQUESTED" || g.status === "ACTIVE") && g.ticketId === input.ticketId)) {
      deny(new AppError(409, "INVALID_STATE", "Already open for this ticket", "Use or close the existing access first."));
    }
    const all = s.data.merchants("TEST");
    const ms = [...new Set(input.merchantIds)].map((id) => all.find((m) => m.id === id));
    if (!ms.length || ms.length > LIMITS.maxMerchants) deny(new AppError(400, "VALIDATION_FAILED", `Name between 1 and ${LIMITS.maxMerchants} merchants`));
    if (ms.some((m) => !m)) deny(new AppError(400, "VALIDATION_FAILED", "Unknown merchant"));
    const found = ms.filter((m): m is NonNullable<typeof m> => !!m);
    // One organisation and one legal cell per grant: never cross-tenant or cross-cell.
    if (new Set(found.map((m) => m.tenantId)).size > 1) deny(new AppError(400, "VALIDATION_FAILED", "One organisation per request", "Exceptional access never spans organisations."));
    if (new Set(found.map((m) => m.legalEntityId)).size > 1) deny(new AppError(400, "VALIDATION_FAILED", "One legal cell per request", "Exceptional access never spans cells."));

    const first = found[0];
    if (!first) return deny(new AppError(400, "VALIDATION_FAILED", "Name at least one merchant"));
    const at = this.iso();
    this.seq += 1;
    const g: Grant = {
      id: `xa_${String(this.seq).padStart(5, "0")}`, kind: input.kind, ticketId: input.ticketId, ...(input.consentRef ? { consentRef: input.consentRef } : {}),
      purpose: input.purpose, environment: "TEST", legalEntityId: first.legalEntityId, tenantId: first.tenantId,
      merchantIds: found.map((m) => m.id), unmasked: [...new Set(input.unmasked)], durationMinutes: input.durationMinutes,
      requestedBySub: p.sub, requestedByName: p.displayName, requestedRole: role, requestedAt: at,
      status: "REQUESTED", version: 1, reads: [],
      history: [{ at, event: `Requested ${input.durationMinutes} min, ${input.unmasked.length ? `unmasked: ${input.unmasked.join(", ")}` : "masked"}`, actor: p.displayName, note: input.purpose }],
    };
    this.grants.push(g);
    s.audit.append({ ...auditActor(ctx), action: "exceptional.request", outcome: "SUCCEEDED", resource: { type: "exceptional_access", id: g.id },
      detail: { kind: g.kind, ticket: g.ticketId, merchants: g.merchantIds.length, minutes: g.durationMinutes } });
    return this.view(s, p, g, true);
  }

  act(s: Services, ctx: CallContext, id: string, name: XaAction, input: ActionInput) {
    const p = ctx.principal;
    const audit = `exceptional.${name}`;
    const deny = (err: AppError): never => {
      s.audit.append({ ...auditActor(ctx), action: audit, outcome: "DENIED", resource: { type: "exceptional_access", id }, detail: { code: err.code } });
      throw err;
    };
    this.requireArea(s, ctx, audit);
    this.sweep(s);
    const g = this.grants.find((x) => x.id === id);
    if (!g || !this.visible(p, g)) return deny(errors.notFound("Access request"));
    const why = this.blocked(p, name, g);
    if (why) deny(why);
    if (g.version !== input.version) deny(new AppError(409, "STALE_VERSION", "This request changed since you opened it", "Reload it and review again."));
    const rule = ExceptionalAccessStore.RULES[name];
    const reason = input.reason?.trim() ?? "";
    if (rule.reasonRequired && reason.length < 10) deny(new AppError(400, "VALIDATION_FAILED", "A reason is required", "Write at least 10 characters."));
    if (rule.stepUp && !stepUpFresh(p, s.now())) deny(new AppError(401, "STEP_UP_REQUIRED", "Confirm your password", "This action needs your password again within the last 5 minutes."));

    const now = this.now();
    const note = reason || undefined;
    if (name === "approve") {
      g.status = "ACTIVE";
      g.version += 1;
      g.approvedBySub = p.sub;
      g.approvedByName = p.displayName;
      g.approvedAt = this.iso(now);
      // The clock starts at approval.
      g.expiresAt = this.iso(now + g.durationMinutes * MIN);
      g.history.push({ at: g.approvedAt, event: `Approved until ${g.expiresAt.slice(11, 16)} UTC`, actor: p.displayName, ...(note ? { note } : {}) });
    } else if (name === "reject") {
      this.end(g, "REJECTED", "Rejected", p.displayName, now, note);
    } else if (name === "revoke") {
      this.end(g, "REVOKED", "Revoked (effective immediately)", p.displayName, now, note);
    } else if (name === "close") {
      this.end(g, "CLOSED", "Closed by holder: work done", p.displayName, now, note);
    } else {
      if (!input.outcome) deny(new AppError(400, "VALIDATION_FAILED", "Choose a review outcome"));
      g.review = { bySub: p.sub, byName: p.displayName, outcome: input.outcome ?? "in_policy", notes: reason, at: this.iso(now) };
      g.version += 1;
      g.history.push({ at: g.review.at, event: g.review.outcome === "in_policy" ? "Reviewed: within policy" : "Reviewed: escalated", actor: p.displayName, note: reason });
    }
    s.audit.append({ ...auditActor(ctx), action: audit, outcome: "SUCCEEDED", resource: { type: "exceptional_access", id: g.id },
      detail: { to: g.status, version: input.version, ...(name === "review" ? { outcome: input.outcome ?? "" } : {}) } });
    return this.view(s, p, g, true);
  }

  // --- The read window ------------------------------------------------------

  /** The grant the caller may read through right now, or a refusal. Checked on every read. */
  private live(s: Services, ctx: CallContext, id: string): Grant {
    this.requireArea(s, ctx, "exceptional.use");
    this.sweep(s);
    const g = this.grants.find((x) => x.id === id);
    const ok = g && g.requestedBySub === ctx.principal.sub && g.status === "ACTIVE" && !!g.expiresAt && this.now() < Date.parse(g.expiresAt);
    if (!ok) {
      s.audit.append({ ...auditActor(ctx), action: "exceptional.use", outcome: "DENIED", resource: { type: "exceptional_access", id } });
      throw new AppError(403, "FORBIDDEN", "No active access", "This access is not active for you. It may have expired, been revoked or closed.");
    }
    return g;
  }

  private covers(g: Grant, pay: Payment): boolean {
    return pay.environment === g.environment && pay.legalEntityId === g.legalEntityId && pay.tenantId === g.tenantId && g.merchantIds.includes(pay.merchantId);
  }

  /** Read-only, masked unless a field was approved. No money action is reachable from here. */
  private masked(s: Services, g: Grant, pay: Payment) {
    return {
      id: pay.id, merchantId: pay.merchantId,
      merchantName: s.data.merchants("TEST").find((m) => m.id === pay.merchantId)?.displayName ?? pay.merchantId,
      amountMinor: pay.amountMinor, currency: pay.currency, status: pay.status, attemptStatus: pay.attemptStatus,
      createdAt: pay.createdAt, updatedAt: pay.updatedAt, connector: pay.connector,
      customerEmail: g.unmasked.includes("customer_email") ? pay.customerEmail : maskEmail(pay.customerEmail),
      method: g.unmasked.includes("card_details") ? pay.method : { type: pay.method.type, brand: pay.method.brand, last4: "••••" },
    };
  }

  private logRead(s: Services, ctx: CallContext, g: Grant, resource: string, fields: string[]): void {
    g.reads.push({ at: this.iso(), resource, fields });
    s.audit.append({ ...auditActor(ctx), action: "exceptional.use", outcome: "ALLOWED", resource: { type: "exceptional_access", id: g.id },
      detail: { ticket: g.ticketId, read: resource, unmasked: g.unmasked.join(",") || "none" } });
  }

  payments(s: Services, ctx: CallContext, id: string, q: { q?: string }) {
    const g = this.live(s, ctx, id);
    const needle = q.q?.toLowerCase();
    const rows = s.data.payments("TEST").filter((pay) => this.covers(g, pay) && (!needle || pay.id.toLowerCase().includes(needle)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
    this.logRead(s, ctx, g, `payments list (${rows.length} rows)`, ["list"]);
    return { grant: { id: g.id, ticketId: g.ticketId, expiresAt: g.expiresAt, unmasked: g.unmasked }, items: rows.map((pay) => this.masked(s, g, pay)) };
  }

  payment(s: Services, ctx: CallContext, id: string, paymentId: string) {
    const g = this.live(s, ctx, id);
    const pay = s.data.payments("TEST").find((x) => x.id === paymentId);
    // Outside the grant and non-existent look the same.
    if (!pay || !this.covers(g, pay)) {
      s.audit.append({ ...auditActor(ctx), action: "exceptional.use", outcome: "DENIED", resource: { type: "payment", id: paymentId }, detail: { grant: g.id } });
      throw errors.notFound("Payment");
    }
    this.logRead(s, ctx, g, paymentId, ["detail", ...g.unmasked]);
    return { ...this.masked(s, g, pay), timeline: pay.timeline.map((e) => ({ ...e })) };
  }
}
