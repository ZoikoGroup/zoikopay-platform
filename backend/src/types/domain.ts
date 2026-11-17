/**
 * Domain vocabulary used by the console. Status names are copied verbatim
 * from the governing specs; the console never invents lifecycle states.
 */

export type Environment = "TEST" | "LIVE";
export const ENVIRONMENTS: readonly Environment[] = ["TEST", "LIVE"];

/** 06-01 §2.1 public intent_status vocabulary (canonical v1). */
export const INTENT_STATUSES = [
  "REQUIRES_PAYMENT_METHOD",
  "REQUIRES_CONFIRMATION",
  "REQUIRES_CUSTOMER_ACTION",
  "PROCESSING",
  "REQUIRES_CAPTURE",
  "PARTIALLY_CAPTURED",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "EXPIRED",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** 06-01 §2.2 attempt_status (illustrative values). */
export type AttemptStatus =
  | "RESERVED" | "DISPATCHING" | "ACTION_REQUIRED" | "PENDING" | "AUTHORIZED"
  | "SUCCEEDED" | "DECLINED" | "NO_EFFECT" | "UNKNOWN";

/** 04-05 §7 payout state machine. */
export const PAYOUT_STATUSES = [
  "REQUIRES_APPROVAL", "READY", "PROCESSING", "OUTCOME_UNKNOWN", "PROVIDER_ACCEPTED",
  "SUCCEEDED", "FAILED_NO_EFFECT", "CANCELED", "RETURNED",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
/** 04-05 §7: approval_status is a separate axis from payout_status. */
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";
/** 04-05 example value; the full external_evidence_status set is not yet specified. */
export type EvidenceStatus = "UNVERIFIED" | "VERIFIED";

/** Where a fact came from (Business Requirements 07: provenance next to every amount/status). */
export type Provenance = "provider_confirmed" | "internal_record" | "pending_evidence";

export interface LegalEntity {
  id: string; // cell id, e.g. cell_uk_01
  name: string;
  jurisdiction: string;
  baseCurrency: string;
}

export interface Merchant {
  id: string; // mer_
  tenantId: string; // ten_
  legalEntityId: string;
  displayName: string;
  currencies: string[];
  environment: Environment;
}

export interface ScopedResource {
  tenantId: string;
  merchantId: string;
  legalEntityId: string;
  environment: Environment;
}

export interface EvidenceEvent {
  at: string;
  type: string;
  status: string;
  source: string;
  provenance: Provenance;
  operationId?: string;
  note?: string;
}

export interface Payment extends ScopedResource {
  id: string; // pi_
  amountMinor: string;
  currency: string;
  status: IntentStatus;
  attemptStatus: AttemptStatus;
  createdAt: string;
  updatedAt: string;
  method: { type: "card"; brand: string; last4: string };
  customerEmail: string; // PII: never returned unmasked
  risk: { score: number; outcome: "pass" | "review" | "blocked" };
  connector: string;
  timeline: EvidenceEvent[];
}

export interface PayoutGate {
  name: "maker_checker" | "funds" | "sanctions" | "policy";
  state: "PASSED" | "PENDING";
}

export interface Payout extends ScopedResource {
  id: string; // po_
  version: number;
  amountMinor: string;
  currency: string;
  beneficiaryId: string; // ben_
  beneficiaryLabel: string;
  purposeCode: string;
  status: PayoutStatus;
  approvalStatus: ApprovalStatus;
  externalEvidenceStatus: EvidenceStatus;
  latestOperationId: string; // op_
  makerSub: string;
  makerName: string;
  checkerSub?: string;
  checkerName?: string;
  decisionReason?: string;
  decidedAt?: string;
  approvalDeadline: string;
  gates: PayoutGate[];
  createdAt: string;
  updatedAt: string;
}

export interface SettlementBatch extends ScopedResource {
  id: string;
  currency: string;
  date: string;
  /** Fixture-only vocabulary: reconciliation states are owned by 09-xx specs not yet supplied. */
  status: "RECONCILED" | "AWAITING_EVIDENCE" | "EXCEPTION";
}

export interface ActivityEvent extends ScopedResource {
  id: string;
  at: string;
  kind: "payment_settled" | "merchant_application" | "refund_review" | "payout_completed" | "risk_alert" | "approval";
  title: string;
  resource: { type: "payment" | "payout" | "merchant" | "refund" | "risk_case"; id: string };
}
