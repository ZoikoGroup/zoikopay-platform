import { PERSONA_LABELS, type Persona } from "../authorization/permissions.js";
import { hasPermission } from "../authorization/policy.js";
import { TENANTS } from "../database/fixtures.js";
import { errors } from "../types/errors.js";
import { auditActor, type CallContext, type Services } from "./context.js";

/**
 * Super Admin "Platform" page (03-05 §10.1).
 *
 * "Zoiko Pay Super Admin is an administrative coordination role, not a
 * universal merchant-data, PSP-secret, funds-transfer or financial-ledger
 * privilege. Default dashboard shows service health, counts and redacted
 * tenant metadata rather than unrestricted merchant transactions or PII."
 *
 * So everything here is a count or an identifier. No amounts, no customer or
 * staff names, no payment records, no secrets, no audit bodies. Service health
 * comes from the existing /system/health endpoint.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Display name of a fixture tenant; unknown tenants show their ID only. */
function tenantName(id: string): string {
  return TENANTS.find((t) => t.id === id)?.name ?? id;
}

export function platformSummary(s: Services, ctx: CallContext) {
  const p = ctx.principal;
  if (!hasPermission(p, "area.platform")) {
    s.audit.append({ ...auditActor(ctx), action: "platform.summary", outcome: "DENIED" });
    throw errors.forbidden();
  }

  // Counts per legal cell, for the selected environment only. LIVE has no data
  // source yet, so the data source refuses it with 503 LIVE_DATA_UNAVAILABLE
  // rather than this page quietly showing TEST counts under a LIVE badge.
  const env = p.environment;
  const merchants = s.data.merchants(env);
  const payments = s.data.payments(env);
  const cells = s.data.legalEntities().map((e) => ({
    id: e.id,
    name: e.name,
    jurisdiction: e.jurisdiction,
    organisations: new Set(merchants.filter((m) => m.legalEntityId === e.id).map((m) => m.tenantId)).size,
    merchants: merchants.filter((m) => m.legalEntityId === e.id).length,
    payments: payments.filter((x) => x.legalEntityId === e.id).length,
  }));

  // Items waiting for someone's decision, per screen. Counts only.
  const awaiting = s.screens.allDefs().map((d) => {
    const waiting = new Set(Object.values(d.actions).filter((r) => r.label !== "Run simulation").flatMap((r) => r.from));
    return { screenId: d.id, title: d.title, count: s.screens.rawRows(d.id).filter((r) => waiting.has(r.status)).length };
  }).filter((x) => x.count > 0);

  // Redacted tenant metadata: identifier, name, cells and merchant count.
  const tenantIds = [...new Set(merchants.map((m) => m.tenantId))].sort();
  const organisations = tenantIds.map((t) => {
    const ms = merchants.filter((m) => m.tenantId === t);
    return { id: t, name: tenantName(t), cells: [...new Set(ms.map((m) => m.legalEntityId))].sort(), merchants: ms.length, environments: [env] };
  });

  // How many people hold each role. Names are not shown.
  const byRole = new Map<Persona, number>();
  for (const m of s.directory.all()) for (const persona of m.personas) byRole.set(persona, (byRole.get(persona) ?? 0) + 1);
  const roles = [...byRole.entries()].map(([persona, count]) => ({ persona, label: PERSONA_LABELS[persona], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  // Security signals from the audit log, last 24 hours. Counts only.
  const since = s.now() - DAY_MS;
  const recent = s.audit.list().filter((e) => Date.parse(e.at) >= since);
  const count = (pred: (e: (typeof recent)[number]) => boolean) => recent.filter(pred).length;
  const signals = [
    { key: "signins", label: "Successful sign-ins", count: count((e) => e.action === "auth.login" && e.outcome === "SUCCEEDED") },
    { key: "failed_signins", label: "Failed sign-ins", count: count((e) => e.action === "auth.login" && e.outcome === "FAILED") },
    { key: "denied", label: "Refused requests", count: count((e) => e.outcome === "DENIED") },
    { key: "stepup_failed", label: "Failed password re-checks", count: count((e) => e.action === "auth.step_up" && e.outcome === "FAILED") },
    { key: "decisions", label: "Approvals and other decisions", count: count((e) => e.action.startsWith("screen.") && e.outcome === "SUCCEEDED") },
  ];
  const chain = s.audit.verify();

  s.audit.append({ ...auditActor(ctx), action: "platform.summary", outcome: "ALLOWED" });
  return {
    totals: {
      organisations: organisations.length,
      merchants: merchants.length,
      payments: payments.length,
      awaitingDecision: awaiting.reduce((n, x) => n + x.count, 0),
      people: s.directory.all().length,
    },
    cells,
    awaiting,
    organisations,
    roles,
    signals: { windowHours: 24, items: signals, auditChain: { valid: chain.valid, entries: chain.checked } },
    // ADR 0004 / Q19: Super Admin sees counts of exceptional access, never tickets or resources.
    exceptionalAccess: s.exceptional.counts(s),
    environment: env,
    environmentNote: `Counts are from the ${env} environment (development fixtures). LIVE has no data source yet.`,
  };
}
