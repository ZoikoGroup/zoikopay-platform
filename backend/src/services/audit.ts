import { createHash } from "node:crypto";
import type { Environment } from "../types/domain.js";

export type AuditOutcome = "ALLOWED" | "DENIED" | "SUCCEEDED" | "FAILED";

export interface AuditInput {
  actorSub: string;
  actorUsername: string;
  action: string; // e.g. "payout.approve", "payments.read", "access.exceptional.approve"
  outcome: AuditOutcome;
  environment?: Environment;
  resource?: { type: string; id: string };
  /** Short, non-sensitive context. Never request bodies, PII or secrets. */
  detail?: Record<string, string | number | boolean>;
  requestId?: string;
}

export interface AuditEntry extends AuditInput {
  seq: number;
  at: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function digest(prevHash: string, body: Omit<AuditEntry, "hash">): string {
  // Stable field order so verification recomputes the same bytes.
  const canonical = JSON.stringify([
    body.seq, body.at, body.actorSub, body.actorUsername, body.action, body.outcome,
    body.environment ?? null, body.resource ?? null, body.detail ?? null, body.requestId ?? null,
  ]);
  return createHash("sha256").update(prevHash).update(canonical).digest("hex");
}

/**
 * Append-only, hash-chained audit log. Each entry commits to the previous
 * entry's hash, so any edit, deletion or reordering breaks verification.
 *
 * Development limitation: entries live in process memory and are lost on
 * restart. The durable, independently stored evidence log belongs to BC-08
 * governance (Go) and does not exist yet.
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  append(input: AuditInput): AuditEntry {
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
    const body = { ...input, seq: this.entries.length + 1, at: this.now().toISOString(), prevHash };
    const entry: AuditEntry = Object.freeze({ ...body, hash: digest(prevHash, body) });
    this.entries.push(entry);
    return entry;
  }

  list(filter: { action?: string; actorSub?: string; outcome?: AuditOutcome } = {}): readonly AuditEntry[] {
    return this.entries.filter(
      (e) =>
        (!filter.action || e.action.startsWith(filter.action)) &&
        (!filter.actorSub || e.actorSub === filter.actorSub) &&
        (!filter.outcome || e.outcome === filter.outcome),
    );
  }

  /** Recomputes the whole chain. Returns the first broken sequence number, if any. */
  verify(entries: readonly AuditEntry[] = this.entries): { valid: boolean; checked: number; brokenAt?: number } {
    let prev = GENESIS;
    for (const e of entries) {
      const { hash, ...body } = e;
      if (e.prevHash !== prev || digest(prev, body) !== hash) return { valid: false, checked: entries.length, brokenAt: e.seq };
      prev = hash;
    }
    return { valid: true, checked: entries.length };
  }
}
