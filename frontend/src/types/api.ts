/** Types for the console backend API (/api/v1). Mirrors the backend contract. */

export type Environment = "TEST" | "LIVE";
export type DataSource = "fixture" | "live-service" | "console";

export interface Meta {
  requestId: string;
  environment: Environment | null;
  source: DataSource;
  asOf: string;
}

export interface Envelope<T> {
  data: T;
  meta: Meta;
}

export type Permission =
  | "overview.view" | "metrics.counts.view" | "metrics.amounts.view" | "payments.read" | "payments.method.view"
  | "risk.read" | "payouts.read" | "ledger.read" | "health.view"
  | "area.merchants" | "area.payment_operations" | "area.routing" | "area.partners" | "area.refunds_disputes"
  | "area.finance" | "area.payouts" | "area.risk_compliance" | "area.developers" | "area.audits" | "area.qa_release"
  | "area.access" | "area.platform" | "area.exceptional";

export interface Me {
  sub: string;
  username: string;
  displayName: string;
  personas: string[];
  permissions: Permission[];
  environment: Environment;
  environments: Environment[];
  hasAccess: boolean;
  stepUpValidUntil: string | null;
}

export interface ScopeOptions {
  environment: Environment;
  environments: Environment[];
  legalEntities: { id: string; name: string; jurisdiction: string; baseCurrency: string }[];
  merchants: { id: string; displayName: string; legalEntityId: string; currencies: string[] }[];
  currencies: string[];
  liveUnavailable: boolean;
  canSeeMerchantList: boolean;
}

export type IntentStatus =
  | "REQUIRES_PAYMENT_METHOD" | "REQUIRES_CONFIRMATION" | "REQUIRES_CUSTOMER_ACTION" | "PROCESSING"
  | "REQUIRES_CAPTURE" | "PARTIALLY_CAPTURED" | "SUCCEEDED" | "FAILED" | "CANCELED" | "EXPIRED";

export const INTENT_STATUSES: IntentStatus[] = [
  "REQUIRES_PAYMENT_METHOD", "REQUIRES_CONFIRMATION", "REQUIRES_CUSTOMER_ACTION", "PROCESSING",
  "REQUIRES_CAPTURE", "PARTIALLY_CAPTURED", "SUCCEEDED", "FAILED", "CANCELED", "EXPIRED",
];

export interface Payment {
  id: string;
  merchantId: string;
  merchantName: string;
  legalEntityId: string;
  environment: Environment;
  amountMinor: string;
  currency: string;
  status: IntentStatus;
  attemptStatus: string;
  createdAt: string;
  updatedAt: string;
  method: { type: string; brand: string; last4: string } | null;
  customerEmailMasked: string;
  risk: { score: number; outcome: string } | null;
  connector: string;
}

export interface EvidenceEvent {
  at: string;
  type: string;
  status: string;
  source: string;
  provenance: "provider_confirmed" | "internal_record" | "pending_evidence";
  operationId?: string;
  note?: string;
}

export interface PaymentDetail extends Payment {
  timeline: EvidenceEvent[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Kpi {
  key: "volume" | "succeeded" | "success_rate" | "fraud_rate" | "pending_approvals" | "settlement";
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

export type Period = "24h" | "7d" | "30d";

export interface KpiResponse {
  period: Period;
  from: string;
  to: string;
  kpis: Kpi[];
}

export interface ActivityBucket {
  start: string;
  end: string;
  count: number;
  succeeded: number;
  failed: number;
  volumeMinor: string | null;
}

export interface ActivityResponse {
  period: Period;
  currency: string;
  amountsVisible: boolean;
  buckets: ActivityBucket[];
}

export interface RecentActivityItem {
  id: string;
  at: string;
  kind: "payment_settled" | "merchant_application" | "refund_review" | "payout_completed" | "risk_alert" | "approval";
  title: string;
  resource: { type: string; id: string };
  merchantId: string;
}

export interface ServiceHealth {
  name: string;
  category: "api" | "connector" | "core" | "identity" | "console";
  status: string;
  ok: boolean;
  checks: Record<string, string>;
  latencyMs: number | null;
  checkedAt: string;
  availability: { percent: number; samples: number } | null;
}

// ---- Access: role and delegation administration (02-02 ZP-PER-WF-002) ----

export interface AccessActionView {
  name: "approve" | "reject" | "revoke" | "narrow";
  label: string;
  stepUp: boolean;
  reasonRequired: boolean;
  allowed: boolean;
  blockedReason?: string;
}

export interface AccessGrant {
  id: string;
  persona: string;
  role: string;
  status: string;
  version: number;
  scope: { kind: "internal" | "merchant"; legalEntityIds: string[]; tenantIds: string[] | "*"; merchantIds: string[] | "*"; environments: string[]; summary: string };
  expiresAt: string | null;
  requestedByName: string;
  requestedAt: string;
  isOwnRequest: boolean;
  reason: string | null;
  history: { at: string; event: string; actor: string; note?: string }[];
  actions: AccessActionView[];
}

export interface AccessMemberRow {
  sub: string;
  username: string;
  displayName: string;
  isSelf: boolean;
  status: string;
  role: string | null;
  persona: string | null;
  requestedRole: string | null;
  scope: string | null;
  expiresAt: string | null;
  grantedBy: string | null;
  nextStep: string | null;
}

export interface AccessMembers {
  summary: { label: string; value: string }[];
  statuses: string[];
  accountsUnavailable: boolean;
  canRequest: boolean;
  total: number;
  items: AccessMemberRow[];
}

export interface AccessMember {
  sub: string;
  username: string;
  displayName: string;
  isSelf: boolean;
  grants: AccessGrant[];
}

export interface AccessOptions {
  roles: { persona: string; label: string; kind: "internal" | "merchant" }[];
  merchants: { id: string; displayName: string; legalEntityId: string }[];
  legalEntities: { id: string; name: string }[];
  environments: Environment[];
  allMerchantsOption: boolean;
  maxExpiryDays: number;
}

export interface AccessRequestBody {
  username: string;
  persona: string;
  merchantIds?: string[];
  legalEntityIds?: string[];
  environments: Environment[];
  expiresAt?: string;
  reason: string;
}

// ---- Exceptional access (ADR 0004; 02-02 WF-007, WF-011) ----

export type XaKind = "support" | "breakglass";

export interface XaActionView {
  name: "approve" | "reject" | "revoke" | "close" | "review";
  label: string;
  stepUp: boolean;
  reasonRequired: boolean;
  allowed: boolean;
  blockedReason?: string;
}

export interface XaGrant {
  id: string;
  kind: XaKind;
  ticketId: string;
  consentRef: string | null;
  purpose: string;
  status: string;
  version: number;
  scope: { environment: string; legalEntityId: string; tenantId: string; merchants: { id: string; name: string }[]; resources: string; unmasked: string[] };
  durationMinutes: number;
  requestedByName: string;
  requestedRole: string;
  requestedAt: string;
  isMine: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  reviewDue: boolean;
  reviewOverdue: boolean;
  review: { byName: string; outcome: "in_policy" | "escalate"; notes: string; at: string } | null;
  readCount: number;
  actions: XaActionView[];
  history?: { at: string; event: string; actor: string; note?: string }[];
  reads?: { at: string; resource: string; fields: string[] }[];
}

export interface XaList {
  canRequest: XaKind[];
  isApprover: boolean;
  summary: { label: string; value: string }[];
  items: XaGrant[];
}

export interface XaOptions {
  kinds: { kind: XaKind; label: string; maxMinutes: number }[];
  merchants: { id: string; name: string; tenantId: string; legalEntityId: string }[];
  unmaskable: string[];
  maxMerchants: number;
}

export interface XaPayment {
  id: string;
  merchantId: string;
  merchantName: string;
  amountMinor: string;
  currency: string;
  status: string;
  attemptStatus: string;
  createdAt: string;
  updatedAt: string;
  connector: string;
  customerEmail: string;
  method: { type: string; brand: string; last4: string };
  timeline?: { at: string; type: string; status: string; source: string; note?: string }[];
}

/** Super Admin platform page (03-05 §10.1): counts and identifiers only. */
export interface PlatformSummary {
  totals: { organisations: number; merchants: number; payments: number; awaitingDecision: number; people: number };
  cells: { id: string; name: string; jurisdiction: string; organisations: number; merchants: number; payments: number }[];
  awaiting: { screenId: string; title: string; count: number }[];
  organisations: { id: string; name: string; cells: string[]; merchants: number; environments: string[] }[];
  roles: { persona: string; label: string; count: number }[];
  signals: { windowHours: number; items: { key: string; label: string; count: number }[]; auditChain: { valid: boolean; entries: number } };
  environmentNote: string;
  exceptionalAccess: { waiting: number; active: number; reviewDue: number; reviewOverdue: number };
}

export interface SystemHealth {
  source: "live-service";
  monitoringSince: string;
  lastCheck: string | null;
  intervalSeconds: number;
  database: { status: string; reportedBy: string[] };
  services: ServiceHealth[];
}

// ---- Console screens (ZP-BRW-001 … 014) ----

export interface MoneyValue {
  minor: string;
  currency: string;
}

export type FieldValue = string | number | boolean | null | MoneyValue | string[] | Record<string, string>;

export interface ActionView {
  /** Routine action (archive, pause, …): not shown as a "next step". */
  quiet?: boolean;
  name: string;
  label: string;
  reasonRequired: boolean;
  stepUp: boolean;
  source: string;
  allowed: boolean;
  blockedReason?: string;
}

export interface RecordView {
  id: string;
  status: string;
  version: number;
  merchantId?: string;
  legalEntityId?: string;
  environment: Environment;
  requestedByName?: string;
  isOwnRequest: boolean;
  fields: Record<string, FieldValue>;
  updatedAt: string;
  actions: ActionView[];
  timeline?: { at: string; event: string; actor: string; note?: string }[];
}

/** A server-side "create" form (TEST fixtures); the server re-validates every value. */
export interface CreateFormView {
  label: string;
  source: string;
  allowed: boolean;
  blockedReason?: string;
  fields: { key: string; label: string; type: "text" | "money" | "number" | "select" | "date"; required: boolean; options?: string[]; hint?: string }[];
}

export interface ScreenList {
  screen: { id: string; title: string };
  summary: { label: string; value: string }[];
  statuses: string[];
  create?: CreateFormView;
  total: number;
  items: RecordView[];
}

export interface SearchHit {
  kind: "payment" | "record";
  screenId?: string;
  id: string;
  label: string;
}

export interface Notification {
  id: string;
  at: string;
  title: string;
  screenId: string;
  recordId: string;
  read: boolean;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actorUsername: string;
  action: string;
  outcome: "ALLOWED" | "DENIED" | "SUCCEEDED" | "FAILED";
  resource?: { type: string; id: string };
  detail?: Record<string, string | number | boolean>;
  hash: string;
}

export interface AuditResponse {
  verification: { valid: boolean; checked: number; brokenAt?: number };
  total: number;
  items: AuditEntry[];
}

export interface SandboxIntent {
  id: string;
  status: string;
  next_action: null;
  amount_minor: string;
  currency: string;
  capture_mode: string;
  order_ref: string;
  created_at: string;
  client_token_ref: string;
  simulated: true;
  notice: string;
  idempotent_replay: boolean;
}

export type SsoProviderId = 'microsoft' | 'google' | 'apple' | 'company';
export interface SsoProviderOption { id: SsoProviderId; enabled: boolean }
