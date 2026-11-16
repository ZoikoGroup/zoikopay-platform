import { canRead, hasPermission } from "../authorization/policy.js";
import type { IntentStatus, Payment } from "../types/domain.js";
import { errors } from "../types/errors.js";
import type { PaymentListQuery } from "../validators/payments.js";
import { auditActor, type CallContext, type Services } from "./context.js";
import { compareMinor } from "./money.js";

export interface PaymentView {
  id: string;
  merchantId: string;
  merchantName: string;
  legalEntityId: string;
  environment: string;
  amountMinor: string;
  currency: string;
  status: IntentStatus;
  attemptStatus: string;
  createdAt: string;
  updatedAt: string;
  /** null when the caller may not see payment-method detail. */
  method: { type: string; brand: string; last4: string } | null;
  customerEmailMasked: string;
  risk: { score: number; outcome: string } | null;
  connector: string;
}

export interface PaymentDetailView extends PaymentView {
  timeline: Payment["timeline"];
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

function merchantName(s: Services, ctx: CallContext, merchantId: string): string {
  return s.data.merchants(ctx.principal.environment).find((m) => m.id === merchantId)?.displayName ?? merchantId;
}

function toView(s: Services, ctx: CallContext, p: Payment): PaymentView {
  const pr = ctx.principal;
  return {
    id: p.id,
    merchantId: p.merchantId,
    merchantName: merchantName(s, ctx, p.merchantId),
    legalEntityId: p.legalEntityId,
    environment: p.environment,
    amountMinor: p.amountMinor,
    currency: p.currency,
    status: p.status,
    attemptStatus: p.attemptStatus,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    method: hasPermission(pr, "payments.method.view") ? p.method : null,
    customerEmailMasked: maskEmail(p.customerEmail),
    risk: hasPermission(pr, "risk.read") ? p.risk : null, // 02-02 RISK.CASE.READ: PRISK, PCOMP, POR
    connector: p.connector,
  };
}

export function listPayments(s: Services, ctx: CallContext, q: PaymentListQuery) {
  const pr = ctx.principal;
  if (!hasPermission(pr, "payments.read")) {
    s.audit.append({ ...auditActor(ctx), action: "payments.list", outcome: "DENIED" });
    throw errors.forbidden();
  }
  const needle = q.q?.toLowerCase();
  const rows = s.data.payments(pr.environment).filter((p) =>
    canRead(pr, "payments.read", p) &&
    (!q.status?.length || q.status.includes(p.status)) &&
    (!q.merchantId || p.merchantId === q.merchantId) &&
    (!q.legalEntityId || p.legalEntityId === q.legalEntityId) &&
    (!q.currency || p.currency === q.currency) &&
    (!q.from || p.createdAt >= q.from) &&
    (!q.to || p.createdAt <= q.to) &&
    (!needle || p.id.toLowerCase().includes(needle) || p.merchantId.includes(needle) ||
      merchantName(s, ctx, p.merchantId).toLowerCase().includes(needle)));

  const dir = q.order === "asc" ? 1 : -1;
  rows.sort((a, b) =>
    q.sort === "amount"
      // Amounts in different currencies are not comparable: group by currency first.
      ? (a.currency.localeCompare(b.currency) || compareMinor(a.amountMinor, b.amountMinor)) * dir
      : a.createdAt.localeCompare(b.createdAt) * dir);

  const start = (q.page - 1) * q.pageSize;
  return {
    items: rows.slice(start, start + q.pageSize).map((p) => toView(s, ctx, p)),
    total: rows.length,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export function getPayment(s: Services, ctx: CallContext, id: string): PaymentDetailView {
  const pr = ctx.principal;
  const p = s.data.payments(pr.environment).find((x) => x.id === id);
  // Out-of-scope and non-existent look identical, so IDs cannot be probed.
  if (!p || !canRead(pr, "payments.read", p)) {
    s.audit.append({ ...auditActor(ctx), action: "payments.read", outcome: "DENIED", resource: { type: "payment", id } });
    throw errors.notFound("Payment");
  }
  return { ...toView(s, ctx, p), timeline: p.timeline };
}
