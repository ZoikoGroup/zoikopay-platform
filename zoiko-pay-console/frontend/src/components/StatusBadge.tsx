import { humanize } from "../services/format";

/**
 * Monochrome status system. With no colour available, status is carried by a
 * distinct glyph shape and fill weight, always paired with a text label:
 *
 *   positive  ● with check   (filled)        e.g. SUCCEEDED, APPROVED, ACTIVE
 *   attention ◆ with "!"     (filled, bold)  e.g. FAILED, OUTCOME_UNKNOWN, DENIED
 *   pending   ◐              (half filled)   e.g. PROCESSING, REQUIRES_*, PENDING
 *   ended     ○ with dash    (hollow, dim)   e.g. CANCELED, EXPIRED, REVOKED
 *   neutral   ○              (hollow)        anything else
 */
export type Tone = "positive" | "attention" | "pending" | "ended" | "neutral";

const TONES: Record<string, Tone> = {
  SUCCEEDED: "positive", APPROVED: "positive", ACTIVE: "positive", RECONCILED: "positive", VERIFIED: "positive",
  PASSED: "positive", ALLOWED: "positive", PROVIDER_ACCEPTED: "positive", ok: "positive",
  FAILED: "attention", OUTCOME_UNKNOWN: "attention", RETURNED: "attention", DENIED: "attention", EXCEPTION: "attention",
  REJECTED: "attention", error: "attention", unreachable: "attention", degraded: "attention", blocked: "attention",
  PROCESSING: "pending", REQUIRES_PAYMENT_METHOD: "pending", REQUIRES_CONFIRMATION: "pending", REQUIRES_CUSTOMER_ACTION: "pending",
  REQUIRES_CAPTURE: "pending", PARTIALLY_CAPTURED: "pending", REQUIRES_APPROVAL: "pending", PENDING: "pending",
  PENDING_APPROVAL: "pending", AWAITING_EVIDENCE: "pending", READY: "pending", UNVERIFIED: "pending", review: "pending",
  draining: "pending",
  CANCELED: "ended", EXPIRED: "ended", REVOKED: "ended", FAILED_NO_EFFECT: "ended",
  // Statuses of the console screens (ZP-BRW-001 … 014)
  GO: "positive", ENABLED: "positive", CERTIFIED: "positive", RESOLVED: "positive", CLOSED: "positive", IMPLEMENTED: "positive",
  AVAILABLE: "positive", SUPPORTED: "positive", Signed: "positive", Current: "positive", Yes: "positive",
  NO_GO: "attention", BLOCKED: "attention", SUSPENDED: "attention", EXCEPTIONS: "attention", EVIDENCE_DUE: "attention", FAILING: "attention",
  Expired: "attention",
  SUBMITTED: "pending", IN_REVIEW: "pending", INFO_REQUESTED: "pending", PROPOSED: "pending", DRAFT: "pending", OPEN: "pending",
  INQUIRY_SENT: "pending", READY_TO_CLOSE: "pending", PENDING_CHANGE: "pending", PENDING_DECISION: "pending", IN_PROGRESS: "pending",
  DESIGNED: "pending", TESTED: "pending", SIGNED: "pending", Pending: "pending",
  DISABLED: "ended", RETIRED: "ended", No: "ended",
};

export function toneOf(status: string): Tone {
  return TONES[status] ?? "neutral";
}

export function StatusGlyph({ tone, size = 14 }: { tone: Tone; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true, className: "status-icon" } as const;
  switch (tone) {
    case "positive":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill="#fff" />
          <path d="M4.8 8.2 7 10.3l4.2-4.6" fill="none" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "attention":
      return (
        <svg {...common}>
          <path d="M8 .9 15.1 8 8 15.1.9 8Z" fill="#fff" />
          <path d="M8 4.6v4.2" stroke="#000" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11.2" r="1" fill="#000" />
        </svg>
      );
    case "pending":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="#fff" strokeWidth="1.4" />
          <path d="M8 1.6a6.4 6.4 0 0 1 0 12.8Z" fill="#fff" />
        </svg>
      );
    case "ended":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="rgba(255,255,255,.58)" strokeWidth="1.4" />
          <path d="M5 8h6" stroke="rgba(255,255,255,.58)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="rgba(255,255,255,.76)" strokeWidth="1.4" />
        </svg>
      );
  }
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = toneOf(status);
  return (
    <span className="status" data-tone={tone} title={status}>
      <StatusGlyph tone={tone} />
      <span className="status-text">{label ?? humanize(status)}</span>
    </span>
  );
}
