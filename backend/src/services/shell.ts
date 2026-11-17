import { canRead, hasPermission } from "../authorization/policy.js";
import { errors } from "../types/errors.js";
import type { CallContext, Services } from "./context.js";

/**
 * Global shell features required by Business Requirements §07 ("global search;
 * notifications"). Both only ever return records the caller may open.
 */

export interface SearchHit {
  kind: "payment" | "record";
  screenId?: string;
  id: string;
  label: string;
}

export function search(s: Services, ctx: CallContext, q: string): SearchHit[] {
  const p = ctx.principal;
  const needle = q.toLowerCase();
  const out: SearchHit[] = [];
  if (p.environment === "TEST" && hasPermission(p, "payments.read")) {
    for (const pay of s.data.payments("TEST")) {
      if (out.length >= 5) break;
      if (pay.id.includes(needle) && canRead(p, "payments.read", pay)) out.push({ kind: "payment", id: pay.id, label: `Payment · ${pay.status}` });
    }
  }
  for (const r of s.screens.search(s, ctx, q)) out.push({ kind: "record", screenId: r.screenId, id: r.recordId, label: r.label });
  return out.slice(0, 15);
}

/** Screen id of role administration in 02-02, used to link notifications to the Access page. */
export const ACCESS_SCREEN = "ZP-PER-WF-002";

export interface Notification {
  id: string;
  at: string;
  title: string;
  screenId: string;
  recordId: string;
  read: boolean;
}

/** Items awaiting the caller's decision, across every screen they can see. Read state is kept per user in memory. */
export class NotificationService {
  private readonly read = new Map<string, Set<string>>();

  list(s: Services, ctx: CallContext): Notification[] {
    const seen = this.read.get(ctx.principal.sub) ?? new Set<string>();
    const access = s.access.actionable(ctx).map((a) => ({ screenId: ACCESS_SCREEN, recordId: a.sub, label: a.label, at: a.at }));
    const xa = s.exceptional.actionable(s, ctx).map((a) => ({ screenId: a.screenId, recordId: a.id, label: a.label, at: a.at }));
    return [...access, ...xa, ...s.screens.actionable(s, ctx)].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).map((a) => {
      const id = `n_${a.screenId}_${a.recordId}`;
      return { id, at: a.at, title: a.label, screenId: a.screenId, recordId: a.recordId, read: seen.has(id) };
    });
  }

  markRead(s: Services, ctx: CallContext, id: string): void {
    if (!this.list(s, ctx).some((n) => n.id === id)) throw errors.notFound("Notification");
    const set = this.read.get(ctx.principal.sub) ?? new Set<string>();
    set.add(id);
    this.read.set(ctx.principal.sub, set);
  }
}

export function listAudit(s: Services, ctx: CallContext, q: { action?: string; outcome?: "ALLOWED" | "DENIED" | "SUCCEEDED" | "FAILED"; limit: number }) {
  if (!hasPermission(ctx.principal, "area.audits")) throw errors.forbidden();
  const all = s.audit.list({});
  const filtered = all.filter((e) => (!q.action || e.action.startsWith(q.action)) && (!q.outcome || e.outcome === q.outcome));
  return { verification: s.audit.verify(all), total: filtered.length, items: filtered.slice(-q.limit).reverse() };
}
