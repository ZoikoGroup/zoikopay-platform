import { z } from "zod";

/** §07 screens (ZP-BRW-0nn) and the Stripe-parity screens (ZP-COM-0nn). */
export const screenId = z.string().regex(/^ZP-(BRW|COM)-0\d\d$/, "unknown screen");
export const recordId = z.string().regex(/^[A-Za-z0-9_-]{2,80}$/, "invalid record id");
export const actionName = z.string().regex(/^[a-z_]{2,40}$/, "invalid action");

export const screenQuery = z.object({
  status: z.string().regex(/^[A-Z_]{2,40}$/).optional(),
  q: z.string().trim().max(80).optional(),
});

export const actionBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const reauthBody = z.object({ password: z.string().min(1).max(256) }).strict();

export const searchQuery = z.object({ q: z.string().trim().min(2).max(80) });

export const auditQuery = z.object({
  action: z.string().max(60).optional(),
  outcome: z.enum(["ALLOWED", "DENIED", "SUCCEEDED", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const sandboxBody = z
  .object({
    merchantId: z.string().regex(/^mer_[a-z0-9_]{1,60}$/),
    amount_minor: z.string().regex(/^[1-9]\d{0,14}$/, "amount_minor must be a positive integer in minor units, sent as a string"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    capture_mode: z.enum(["automatic", "manual"]),
    order_ref: z.string().trim().min(1).max(64),
  })
  .strict();
