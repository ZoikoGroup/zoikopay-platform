import { z } from "zod";
import { UNMASKABLE } from "../services/exceptional.js";

export const xaId = z.string().regex(/^xa_\d{5}$/, "invalid access id");
export const xaAction = z.enum(["approve", "reject", "revoke", "close", "review"]);
export const xaListQuery = z.object({ status: z.string().regex(/^[A-Z_]{2,20}$/).optional() });
export const xaPaymentsQuery = z.object({ q: z.string().trim().max(80).optional() });

/** No field lets the caller set the approver, status, expiry time or scope beyond named merchants. */
export const xaRequestBody = z
  .object({
    kind: z.enum(["support", "breakglass"]),
    // A ticket or incident id, e.g. SUP-1042 or INC-77 (OPEN_QUESTIONS Q22).
    ticketId: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}-\d{1,8}$/, "use a ticket id like SUP-1042 or INC-77"),
    consentRef: z.string().trim().max(120).optional(),
    purpose: z.string().trim().min(10, "Write at least 10 characters").max(500),
    merchantIds: z.array(z.string().regex(/^mer_[a-z0-9_]{1,60}$/)).min(1).max(20),
    unmasked: z.array(z.enum(UNMASKABLE)).max(UNMASKABLE.length).default([]),
    durationMinutes: z.number().int().min(15).max(240),
  })
  .strict();

export const xaActionBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().max(500).optional(),
    outcome: z.enum(["in_policy", "escalate"]).optional(),
  })
  .strict();
