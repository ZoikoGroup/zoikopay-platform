import { hasPermission, inScope } from "../authorization/policy.js";
import type { Principal } from "../authorization/principal.js";
import { MERCHANTS, type FixtureDataset } from "../database/fixtures.js";
import { auditActor, type CallContext, type Services } from "../services/context.js";
import { AppError, errors } from "../types/errors.js";
import { toMinor } from "./fixtureKit.js";
import { SCREEN_DEFS } from "./registry.js";
import type { ActionRule, CreateRule, ScreenDef, ScreenRecord } from "./types.js";

/** A fresh password re-entry is valid for this long. */
export const STEP_UP_WINDOW_SECONDS = 5 * 60;

export function stepUpFresh(p: Principal, nowMs: number): boolean {
  return p.stepUpAt !== undefined && Math.floor(nowMs / 1000) - p.stepUpAt <= STEP_UP_WINDOW_SECONDS;
}

export interface ActionView {
  name: string;
  label: string;
  reasonRequired: boolean;
  stepUp: boolean;
  source: string;
  /** Whether the server would accept this action from the caller right now (UI hint). */
  allowed: boolean;
  /** Why not, in plain words. */
  blockedReason?: string;
}

export interface RecordView {
  id: string;
  status: string;
  version: number;
  merchantId?: string;
  legalEntityId?: string;
  environment: string;
  requestedByName?: string;
  isOwnRequest: boolean;
  fields: ScreenRecord["fields"];
  updatedAt: string;
  actions: ActionView[];
  timeline?: ScreenRecord["timeline"];
}

/**
 * Holds the mock records of every console screen and applies each screen's
 * action rules. All checks run here, on the server.
 */
export class ScreenStore {
  private readonly records = new Map<string, ScreenRecord[]>();
  private readonly defs = new Map(SCREEN_DEFS.map((d) => [d.id, d]));
  /** Per-screen counter for ids of records created in this process. */
  private readonly created = new Map<string, number>();

  constructor(base: FixtureDataset, now: number) {
    for (const d of SCREEN_DEFS) this.records.set(d.id, d.generate({ now, base }));
  }

  def(id: string): ScreenDef {
    const d = this.defs.get(id);
    if (!d) throw errors.notFound("Screen");
    return d;
  }

  allDefs(): ScreenDef[] {
    return SCREEN_DEFS;
  }

  /** Rows on a screen, for internal use (e.g. dashboard counts), without access checks. */
  rawRows(id: string): ScreenRecord[] {
    return this.records.get(id) ?? [];
  }

  canSeeScreen(p: Principal, d: ScreenDef): boolean {
    return hasPermission(p, d.area);
  }

  /** Scope check: merchant-owned records use full scope; platform records use legal entity and environment. */
  visible(p: Principal, d: ScreenDef, r: ScreenRecord): boolean {
    if (r.environment !== p.environment || !p.scope.environments.includes(r.environment)) return false;
    if (d.scoped) {
      return !!r.tenantId && !!r.merchantId && !!r.legalEntityId &&
        inScope(p, { tenantId: r.tenantId, merchantId: r.merchantId, legalEntityId: r.legalEntityId, environment: r.environment });
    }
    return !r.legalEntityId || p.scope.legalEntityIds.includes(r.legalEntityId);
  }

  /** Why the caller may not perform the action on this record, or null when allowed. */
  private check(p: Principal, rule: ActionRule, r: ScreenRecord): AppError | null {
    if (!rule.deciders.some((x) => p.personas.includes(x))) return new AppError(403, "FORBIDDEN", "Not permitted", "Your role cannot perform this action.");
    if (!rule.from.includes(r.status)) return new AppError(409, "INVALID_STATE", "Action not available", `Not available while the record is ${r.status}.`);
    if (rule.separation && r.requestedBySub === p.sub) {
      return new AppError(403, "SELF_APPROVAL_PROHIBITED", "You raised this request", "An independent person must decide it (requester cannot final-approve).");
    }
    const g = rule.guard?.(r);
    return g ? new AppError(409, "INVALID_STATE", "Action not available", g) : null;
  }

  private view(s: Services, ctx: CallContext, d: ScreenDef, r: ScreenRecord, detail: boolean): RecordView {
    const p = ctx.principal;
    const actions = Object.entries(d.actions).map(([name, rule]) => {
      const why = this.check(p, rule, r);
      return { name, label: rule.label, reasonRequired: rule.reasonRequired, stepUp: rule.stepUp, source: rule.source, allowed: why === null,
        ...(why ? { blockedReason: why.detail ?? why.title } : {}) };
    });
    return {
      id: r.id, status: r.status, version: r.version, merchantId: r.merchantId, legalEntityId: r.legalEntityId, environment: r.environment,
      requestedByName: r.requestedByName, isOwnRequest: r.requestedBySub === p.sub, fields: r.fields, updatedAt: r.updatedAt, actions,
      ...(detail ? { timeline: r.timeline } : {}),
    };
  }

  private rows(s: Services, ctx: CallContext, d: ScreenDef): ScreenRecord[] {
    if (ctx.principal.environment !== "TEST") throw errors.liveUnavailable();
    return (this.records.get(d.id) ?? []).filter((r) => this.visible(ctx.principal, d, r));
  }

  list(s: Services, ctx: CallContext, id: string, q: { status?: string; q?: string }) {
    const d = this.def(id);
    if (!this.canSeeScreen(ctx.principal, d)) {
      s.audit.append({ ...auditActor(ctx), action: `screen.${id}.list`, outcome: "DENIED" });
      throw errors.forbidden();
    }
    const rows = this.rows(s, ctx, d);
    const needle = q.q?.toLowerCase();
    const filtered = rows.filter((r) => (!q.status || r.status === q.status) &&
      (!needle || r.id.toLowerCase().includes(needle) || JSON.stringify(r.fields).toLowerCase().includes(needle)));
    return {
      screen: { id: d.id, title: d.title },
      summary: d.summary(rows),
      statuses: [...new Set(rows.map((r) => r.status))].sort(),
      ...(d.create ? { create: this.createView(ctx.principal, d.create) } : {}),
      total: filtered.length,
      items: filtered.map((r) => this.view(s, ctx, d, r, false)),
    };
  }

  /** The create form and whether the caller may use it (UI hint; create() re-checks everything). */
  private createView(p: Principal, c: CreateRule) {
    const allowed = c.deciders.some((x) => p.personas.includes(x));
    return {
      label: c.label, source: c.source, allowed, ...(allowed ? {} : { blockedReason: "Your role cannot create these records." }),
      fields: c.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, ...(f.options ? { options: f.options } : {}), ...(f.hint ? { hint: f.hint } : {}) })),
    };
  }

  /** Creates one TEST record from a form. Every rule is checked here, on the server, and audited. */
  create(s: Services, ctx: CallContext, id: string, input: { merchantId: string; values: Record<string, string> }): RecordView {
    const d = this.def(id);
    const p = ctx.principal;
    const deny = (err: AppError): never => {
      s.audit.append({ ...auditActor(ctx), action: `screen.${id}.create`, outcome: "DENIED", resource: { type: id, id: "new" }, detail: { code: err.code, why: err.detail ?? err.title } });
      throw err;
    };
    const c = d.create;
    if (!c || !d.scoped) return deny(errors.notFound("Create action"));
    if (!this.canSeeScreen(p, d)) return deny(errors.forbidden());
    if (p.environment !== "TEST") return deny(errors.liveUnavailable());
    if (!c.deciders.some((x) => p.personas.includes(x))) return deny(errors.forbidden("Your role cannot create these records."));
    const merchant = MERCHANTS.find((m) => m.id === input.merchantId);
    if (!merchant || !inScope(p, { tenantId: merchant.tenantId, merchantId: merchant.id, legalEntityId: merchant.legalEntityId, environment: "TEST" })) {
      return deny(new AppError(400, "VALIDATION_FAILED", "Choose a merchant", "Pick a merchant from your scope."));
    }

    const values: Record<string, string> = {};
    for (const f of c.fields) {
      const raw = (input.values[f.key] ?? "").trim();
      const bad = (why: string) => deny(new AppError(400, "VALIDATION_FAILED", `Check “${f.label}”`, why));
      if (!raw) { if (f.required) bad("This field is required."); continue; }
      if (raw.length > 200) bad("Use at most 200 characters.");
      if (f.type === "number" && !/^\d{1,9}$/.test(raw)) bad("Enter a whole number.");
      if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) bad("Use the format YYYY-MM-DD.");
      if (f.type === "select" && !(f.options ?? []).includes(raw)) bad("Choose one of the listed options.");
      if (f.type === "money") {
        const minor = toMinor(raw);
        if (!minor) bad("Enter a positive amount with at most two decimals, for example 12.50.");
        values[f.key] = minor ?? "";
        continue;
      }
      values[f.key] = raw;
    }

    const now = s.now();
    const seq = (this.created.get(id) ?? 0) + 1;
    this.created.set(id, seq);
    const built = c.build({ values, merchant, now, seq });
    const at = new Date(now).toISOString();
    const r: ScreenRecord = {
      id: built.id, status: built.status, version: 1, ...{ tenantId: merchant.tenantId, merchantId: merchant.id, legalEntityId: merchant.legalEntityId }, environment: "TEST",
      ...(built.requested ? { requestedBySub: p.sub, requestedByName: p.displayName } : {}),
      fields: built.fields,
      timeline: [{ at, event: built.event, actor: p.displayName }],
      updatedAt: at,
    };
    this.records.set(id, [r, ...(this.records.get(id) ?? [])]);
    s.audit.append({ ...auditActor(ctx), action: `screen.${id}.create`, outcome: "SUCCEEDED", resource: { type: id, id: r.id }, detail: { status: r.status } });
    return this.view(s, ctx, d, r, true);
  }

  get(s: Services, ctx: CallContext, id: string, recordId: string): RecordView {
    const d = this.def(id);
    const r = this.canSeeScreen(ctx.principal, d) ? this.rows(s, ctx, d).find((x) => x.id === recordId) : undefined;
    if (!r) {
      s.audit.append({ ...auditActor(ctx), action: `screen.${id}.read`, outcome: "DENIED", resource: { type: id, id: recordId } });
      throw errors.notFound("Record");
    }
    return this.view(s, ctx, d, r, true);
  }

  act(s: Services, ctx: CallContext, id: string, recordId: string, action: string, input: { version: number; reason?: string }): RecordView {
    const d = this.def(id);
    const audit = `screen.${id}.${action}`;
    const deny = (err: AppError): never => {
      s.audit.append({ ...auditActor(ctx), action: audit, outcome: "DENIED", resource: { type: id, id: recordId }, detail: { code: err.code, why: err.detail ?? err.title } });
      throw err;
    };
    const rule = d.actions[action];
    if (!rule) return deny(errors.notFound("Action"));
    const r = this.canSeeScreen(ctx.principal, d) ? this.rows(s, ctx, d).find((x) => x.id === recordId) : undefined;
    if (!r) return deny(errors.notFound("Record"));
    const why = this.check(ctx.principal, rule, r);
    if (why) deny(why);
    if (r.version !== input.version) deny(new AppError(409, "STALE_VERSION", "This record changed since you opened it", "Reload it and review again."));
    if (rule.reasonRequired && (input.reason?.trim().length ?? 0) < 10) deny(new AppError(400, "VALIDATION_FAILED", "A reason is required", "Write at least 10 characters."));
    if (rule.stepUp && !stepUpFresh(ctx.principal, s.now())) {
      deny(new AppError(401, "STEP_UP_REQUIRED", "Confirm your password", "This action needs your password again within the last 5 minutes."));
    }

    const at = new Date(s.now()).toISOString();
    if (rule.to) r.status = rule.to;
    if (rule.effect) r.fields = rule.effect(r.fields);
    if (action === "simulate") r.fields = { ...r.fields, simulation: `Deterministic: 1,000 sample intents → mockpsp 100%, 0 unroutable (run ${at})` };
    r.version += 1;
    r.updatedAt = at;
    r.timeline = [...r.timeline, { at, event: rule.label, actor: ctx.principal.displayName, ...(input.reason ? { note: input.reason.trim() } : {}) }];
    s.audit.append({ ...auditActor(ctx), action: audit, outcome: "SUCCEEDED", resource: { type: id, id: recordId },
      detail: { to: r.status, version: input.version, stepUp: rule.stepUp } });
    return this.view(s, ctx, d, r, true);
  }

  /** Records the caller may act on now: the basis for notifications. */
  actionable(s: Services, ctx: CallContext) {
    if (ctx.principal.environment !== "TEST") return [];
    const out: { screenId: string; recordId: string; label: string; at: string }[] = [];
    for (const d of SCREEN_DEFS) {
      if (!this.canSeeScreen(ctx.principal, d)) continue;
      for (const r of this.rows(s, ctx, d)) {
        const act = Object.values(d.actions).find((rule) => rule.label !== "Run simulation" && this.check(ctx.principal, rule, r) === null);
        if (act) out.push({ screenId: d.id, recordId: r.id, label: `${d.title}: ${act.label.toLowerCase()} needed`, at: r.updatedAt });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Text search over records the caller may see. */
  search(s: Services, ctx: CallContext, q: string) {
    if (ctx.principal.environment !== "TEST") return [];
    const needle = q.toLowerCase();
    const out: { screenId: string; recordId: string; label: string }[] = [];
    for (const d of SCREEN_DEFS) {
      if (!this.canSeeScreen(ctx.principal, d)) continue;
      for (const r of this.rows(s, ctx, d)) {
        if (r.id.toLowerCase().includes(needle) || JSON.stringify(r.fields).toLowerCase().includes(needle)) {
          out.push({ screenId: d.id, recordId: r.id, label: `${d.title} · ${r.status}` });
          if (out.length >= 12) return out;
        }
      }
    }
    return out;
  }
}
