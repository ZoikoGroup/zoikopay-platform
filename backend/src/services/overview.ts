import type { Permission } from "../authorization/permissions.js";
import { hasPermission, inScope } from "../authorization/policy.js";
import type { Payment } from "../types/domain.js";
import { errors } from "../types/errors.js";
import type { CallContext, Services } from "./context.js";
import { sumMinor } from "./money.js";

export type Period = "24h" | "7d" | "30d";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIODS: Record<Period, { buckets: number; size: number }> = {
  "24h": { buckets: 24, size: HOUR },
  "7d": { buckets: 7, size: DAY },
  "30d": { buckets: 30, size: DAY },
};

export interface Kpi {
  key: string;
  label: string;
  value: string | null;
  unit: "minor" | "count" | "percent" | "text";
  currency?: string;
  previous: string | null;
  trend: number[];
  restricted: boolean;
  restrictedReason?: string;
  definition: string;
}

/** Percentage with one decimal, computed with integers only. */
function pct(num: number, den: number): string | null {
  if (den === 0) return null;
  const tenths = Math.round((num * 1000) / den);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

interface Window { from: number; to: number }

function windows(period: Period, now: number) {
  const { buckets, size } = PERIODS[period];
  const to = now;
  const from = to - buckets * size;
  return { current: { from, to }, previous: { from: from - buckets * size, to: from }, buckets, size };
}

const within = (p: Payment, w: Window) => {
  const t = Date.parse(p.createdAt);
  return t >= w.from && t < w.to;
};

function scopedPayments(s: Services, ctx: CallContext, merchantId?: string): Payment[] {
  const pr = ctx.principal;
  return s.data.payments(pr.environment).filter((p) => inScope(pr, p) && (!merchantId || p.merchantId === merchantId));
}

function assertMerchantInScope(s: Services, ctx: CallContext, merchantId?: string) {
  if (!merchantId) return;
  const m = s.data.merchants(ctx.principal.environment).find((x) => x.id === merchantId);
  if (!m || !inScope(ctx.principal, { ...m, merchantId: m.id })) throw errors.notFound("Merchant");
}

export function overviewKpis(s: Services, ctx: CallContext, q: { period: Period; currency: string; merchantId?: string }) {
  const pr = ctx.principal;
  if (!hasPermission(pr, "overview.view")) throw errors.forbidden();
  assertMerchantInScope(s, ctx, q.merchantId);
  const counts = hasPermission(pr, "metrics.counts.view");
  const amounts = hasPermission(pr, "metrics.amounts.view");
  const now = s.now();
  const w = windows(q.period, now);
  const pays = counts || amounts ? scopedPayments(s, ctx, q.merchantId) : [];
  const cur = pays.filter((p) => within(p, w.current));
  const prev = pays.filter((p) => within(p, w.previous));

  const bucketOf = (p: Payment) => Math.floor((Date.parse(p.createdAt) - w.current.from) / w.size);
  const series = (rows: Payment[], f: (p: Payment) => number) => {
    const out = new Array<number>(w.buckets).fill(0);
    for (const p of rows) {
      const b = bucketOf(p);
      if (b >= 0 && b < w.buckets) out[b] = (out[b] ?? 0) + f(p);
    }
    return out;
  };
  const succeeded = (rows: Payment[]) => rows.filter((p) => p.status === "SUCCEEDED");
  const volume = (rows: Payment[]) => sumMinor(succeeded(rows).filter((p) => p.currency === q.currency).map((p) => p.amountMinor));
  const rate = (rows: Payment[]) => pct(succeeded(rows).length, rows.filter((p) => p.status === "SUCCEEDED" || p.status === "FAILED").length);
  const fraud = (rows: Payment[]) => pct(rows.filter((p) => p.risk.outcome === "blocked").length, rows.length);

  const noCounts = "Aggregate counts are not part of your role.";
  const kpis: Kpi[] = [
    amounts
      ? { key: "volume", label: "Total payment volume", unit: "minor", currency: q.currency, value: volume(cur), previous: volume(prev),
          // Sparkline only: converted to Number for drawing, never for arithmetic on money.
          trend: series(succeeded(cur).filter((p) => p.currency === q.currency), (p) => Number(p.amountMinor)),
          restricted: false, definition: `Sum of SUCCEEDED payments in ${q.currency}. Other currencies are not converted or added.` }
      : { key: "volume", label: "Total payment volume", unit: "minor", currency: q.currency, value: null, previous: null, trend: [],
          restricted: true, restrictedReason: "Money amounts are not part of your role (03-05 §10.1).", definition: "" },
    counts
      ? { key: "succeeded", label: "Successful transactions", unit: "count", value: String(succeeded(cur).length), previous: String(succeeded(prev).length),
          trend: series(succeeded(cur), () => 1), restricted: false, definition: "Payments with intent_status SUCCEEDED, all currencies." }
      : { key: "succeeded", label: "Successful transactions", unit: "count", value: null, previous: null, trend: [], restricted: true, restrictedReason: noCounts, definition: "" },
    counts
      ? { key: "success_rate", label: "Payment success rate", unit: "percent", value: rate(cur), previous: rate(prev), trend: [],
          restricted: false, definition: "SUCCEEDED ÷ (SUCCEEDED + FAILED). Payments still in progress are excluded." }
      : { key: "success_rate", label: "Payment success rate", unit: "percent", value: null, previous: null, trend: [], restricted: true, restrictedReason: noCounts, definition: "" },
    counts
      ? { key: "fraud_rate", label: "Fraud rate", unit: "percent", value: fraud(cur), previous: fraud(prev), trend: [],
          restricted: false, definition: "Payments blocked by risk screening ÷ all payments created in the period." }
      : { key: "fraud_rate", label: "Fraud rate", unit: "percent", value: null, previous: null, trend: [], restricted: true, restrictedReason: noCounts, definition: "" },
  ];

  // Net volume and dispute rate, as on the Stripe home page. Refunds and
  // disputes come from the ZP-BRW-008 case records in the caller's scope.
  const cases = (w0: Window) => s.screens.rawRows("ZP-BRW-008").filter((r) => {
    const t = Date.parse(r.updatedAt);
    return r.tenantId && r.merchantId && r.legalEntityId && t >= w0.from && t < w0.to &&
      inScope(pr, { tenantId: r.tenantId, merchantId: r.merchantId, legalEntityId: r.legalEntityId, environment: r.environment }) &&
      (!q.merchantId || r.merchantId === q.merchantId);
  });
  const caseAmount = (f: unknown) => (f && typeof f === "object" && "minor" in f && "currency" in f && f.currency === q.currency ? String(f.minor) : "0");
  const returned = (w0: Window) => sumMinor(cases(w0)
    .filter((r) => (r.fields.caseType === "REFUND" && r.status === "SUCCEEDED") || (r.fields.caseType === "DISPUTE" && r.status === "LOST"))
    .map((r) => caseAmount(r.fields.amount)));
  const netVolume = (rows: Payment[], w0: Window) => (BigInt(volume(rows)) - BigInt(returned(w0))).toString();
  kpis.push(amounts
    ? { key: "net_volume", label: "Net volume", unit: "minor", currency: q.currency, value: netVolume(cur, w.current), previous: netVolume(prev, w.previous), trend: [],
        restricted: false, definition: `Gross volume in ${q.currency} minus succeeded refunds and lost disputes in the period (Stripe "net volume").` }
    : { key: "net_volume", label: "Net volume", unit: "minor", currency: q.currency, value: null, previous: null, trend: [],
        restricted: true, restrictedReason: "Money amounts are not part of your role (03-05 §10.1).", definition: "" });
  const disputeRate = (rows: Payment[], w0: Window) => pct(cases(w0).filter((r) => r.fields.caseType === "DISPUTE").length, succeeded(rows).length);
  kpis.push(counts && hasPermission(pr, "area.refunds_disputes")
    ? { key: "dispute_rate", label: "Dispute rate", unit: "percent", value: disputeRate(cur, w.current), previous: disputeRate(prev, w.previous), trend: [],
        restricted: false, definition: "Disputes opened in the period ÷ succeeded payments in the period." }
    : { key: "dispute_rate", label: "Dispute rate", unit: "percent", value: null, previous: null, trend: [], restricted: true,
        restrictedReason: counts ? "Dispute data is limited to refund and dispute roles (ZP-BRW-008)." : noCounts, definition: "" });

  // Payout and settlement figures follow their own 02-02 read permissions, not
  // the general counts permission: a role sees a count only where it could
  // read the underlying records (PAYOUT.READ, LEDGER.READ).
  const payouts = counts && hasPermission(pr, "payouts.read");
  const ledger = counts && hasPermission(pr, "ledger.read");
  if (payouts) {
    // Counted from the payout queue (ZP-BRW-010) so decisions there update this card.
    s.data.payouts(pr.environment); // LIVE guard: throws LIVE_DATA_UNAVAILABLE
    const pending = s.screens.rawRows("ZP-BRW-010").filter((p) =>
      p.status === "REQUIRES_APPROVAL" && p.tenantId && p.merchantId && p.legalEntityId &&
      inScope(pr, { tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: p.environment }) &&
      (!q.merchantId || p.merchantId === q.merchantId));
    kpis.push({ key: "pending_approvals", label: "Pending approvals", unit: "count", value: String(pending.length), previous: null, trend: [],
      restricted: false, definition: "Payouts awaiting an independent checker (04-05 §8)." });
  } else {
    kpis.push({ key: "pending_approvals", label: "Pending approvals", unit: "count", value: null, previous: null, trend: [], restricted: true,
      restrictedReason: counts ? "Payout data is limited to finance and reconciliation roles (02-02 PAYOUT.READ)." : noCounts, definition: "" });
  }
  if (ledger) {
    const since = new Date(now - 7 * DAY).toISOString().slice(0, 10);
    const batches = s.data.settlementBatches(pr.environment).filter((b) => inScope(pr, b) && b.date >= since && (!q.merchantId || b.merchantId === q.merchantId));
    const reconciled = batches.filter((b) => b.status === "RECONCILED").length;
    const exceptions = batches.filter((b) => b.status === "EXCEPTION").length;
    kpis.push({ key: "settlement", label: "Settlement status", unit: "text",
      value: `${reconciled} of ${batches.length} reconciled`, previous: exceptions ? `${exceptions} exception${exceptions === 1 ? "" : "s"}` : "No exceptions",
      trend: [], restricted: false, definition: "Settlement batches in the last 7 days. Fixture vocabulary until the 09-series reconciliation specs are supplied." });
  } else {
    kpis.push({ key: "settlement", label: "Settlement status", unit: "text", value: null, previous: null, trend: [], restricted: true,
      restrictedReason: counts ? "Settlement data is limited to finance, reconciliation and audit roles (02-02 LEDGER.READ)." : noCounts, definition: "" });
  }

  return { period: q.period, from: new Date(w.current.from).toISOString(), to: new Date(w.current.to).toISOString(), kpis };
}

export function activitySeries(s: Services, ctx: CallContext, q: { period: Period; currency: string; merchantId?: string }) {
  const pr = ctx.principal;
  if (!hasPermission(pr, "metrics.counts.view")) throw errors.forbidden("Payment activity needs aggregate metrics access.");
  assertMerchantInScope(s, ctx, q.merchantId);
  const amounts = hasPermission(pr, "metrics.amounts.view");
  const w = windows(q.period, s.now());
  const rows = scopedPayments(s, ctx, q.merchantId).filter((p) => within(p, w.current));
  const buckets = Array.from({ length: w.buckets }, (_, i) => ({
    start: new Date(w.current.from + i * w.size).toISOString(),
    end: new Date(w.current.from + (i + 1) * w.size).toISOString(),
    count: 0, succeeded: 0, failed: 0, volumeMinor: amounts ? "0" : null as string | null,
  }));
  const volumes = new Array<bigint>(w.buckets).fill(0n);
  for (const p of rows) {
    const i = Math.floor((Date.parse(p.createdAt) - w.current.from) / w.size);
    const b = buckets[i];
    if (!b) continue;
    b.count++;
    if (p.status === "SUCCEEDED") {
      b.succeeded++;
      if (p.currency === q.currency) volumes[i] = (volumes[i] ?? 0n) + BigInt(p.amountMinor);
    }
    if (p.status === "FAILED") b.failed++;
  }
  if (amounts) buckets.forEach((b, i) => (b.volumeMinor = (volumes[i] ?? 0n).toString()));
  return { period: q.period, currency: q.currency, amountsVisible: amounts, buckets };
}

/**
 * Recent operational events in the caller's scope. Merchant-level activity is
 * operating data, so it needs payments.read (Super Admin sees none, 03-05 §10.1).
 * Risk alerts also need RISK.CASE.READ and payouts PAYOUT.READ (02-02 §03).
 */
const ACTIVITY_PERMISSION: Partial<Record<string, Permission>> = { risk_alert: "risk.read", payout_completed: "payouts.read" };

export function recentActivity(s: Services, ctx: CallContext) {
  const pr = ctx.principal;
  if (!hasPermission(pr, "overview.view")) throw errors.forbidden();
  if (!hasPermission(pr, "payments.read")) return [];
  return s.data.activity(pr.environment)
    .filter((a) => inScope(pr, a))
    .filter((a) => { const need = ACTIVITY_PERMISSION[a.kind]; return !need || hasPermission(pr, need); })
    .slice(0, 12)
    .map((a) => ({ id: a.id, at: a.at, kind: a.kind, title: a.title, resource: a.resource, merchantId: a.merchantId }));
}
