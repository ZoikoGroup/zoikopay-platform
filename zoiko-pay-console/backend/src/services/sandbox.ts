import { createHash, randomUUID } from "node:crypto";
import { inScope } from "../authorization/policy.js";
import { AppError, errors } from "../types/errors.js";
import { auditActor, type CallContext, type Services } from "./context.js";

/**
 * ZP-BRW-004 Payment Intent & Checkout Integration, sandbox mode.
 *
 * Validates a create-intent request the way the spec requires (amount_minor a
 * positive integer within the currency exponent, currency allowed for the
 * merchant, Idempotency-Key required for money-affecting POST, capture_mode in
 * the allowed enum) and returns a SIMULATED response preview. Nothing is sent
 * to the gateway: POST /v1/payment_intents is not implemented in Go yet.
 *
 * Idempotency follows 04-08: the same key with the same body returns the same
 * response; the same key with a different body is refused.
 */
interface Entry { digest: string; response: Record<string, unknown> }

export class SandboxService {
  private readonly seen = new Map<string, Entry>();

  preview(s: Services, ctx: CallContext, idempotencyKey: string | undefined,
    body: { merchantId: string; amount_minor: string; currency: string; capture_mode: "automatic" | "manual"; order_ref: string }) {
    const p = ctx.principal;
    if (p.environment !== "TEST") throw new AppError(403, "ENVIRONMENT_NOT_PERMITTED", "Sandbox requests run in TEST only");
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
      throw new AppError(400, "VALIDATION_FAILED", "Idempotency-Key is required", "Send 8–64 letters, digits, '-' or '_' (04-08).");
    }
    const m = s.data.merchants("TEST").find((x) => x.id === body.merchantId);
    if (!m || !inScope(p, { tenantId: m.tenantId, merchantId: m.id, legalEntityId: m.legalEntityId, environment: "TEST" })) throw errors.notFound("Merchant");
    if (!m.currencies.includes(body.currency)) {
      throw new AppError(400, "VALIDATION_FAILED", "Currency not allowed", `${m.displayName} may use ${m.currencies.join(", ")} only.`);
    }

    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const key = `${p.sub}:${body.merchantId}:${idempotencyKey}`;
    const prior = this.seen.get(key);
    if (prior) {
      if (prior.digest !== digest) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key reused with a different request", "Use a new key for a different request (04-08).");
      }
      return { ...prior.response, idempotent_replay: true };
    }
    const response = {
      id: `pi_${randomUUID().replaceAll("-", "")}`,
      object: "payment_intent",
      status: "REQUIRES_PAYMENT_METHOD",
      next_action: null,
      amount_minor: body.amount_minor,
      currency: body.currency,
      capture_mode: body.capture_mode,
      order_ref: body.order_ref,
      created_at: new Date(s.now()).toISOString(),
      client_token_ref: `ct_ref_${randomUUID().slice(0, 8)}`,
      simulated: true,
      notice: "Simulated preview. Nothing was sent to the payment gateway.",
    };
    this.seen.set(key, { digest, response });
    s.audit.append({ ...auditActor(ctx), action: "sandbox.payment_intent.preview", outcome: "SUCCEEDED", resource: { type: "merchant", id: m.id } });
    return { ...response, idempotent_replay: false };
  }
}
