import { z } from "zod";
import { PERSONAS } from "../authorization/permissions.js";

export const personSub = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "invalid person id");
export const grantId = z.string().regex(/^grt_\d{5}$/, "invalid grant id");
export const accessAction = z.enum(["approve", "reject", "revoke", "narrow"]);

export const accessQuery = z.object({
  status: z.string().regex(/^[A-Z_]{2,40}$/).optional(),
  q: z.string().trim().max(80).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/, "use YYYY-MM-DD");

/** No field lets the caller set the requester, approver, status or version. */
export const accessRequestBody = z
  .object({
    username: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{2,59}$/, "invalid username"),
    persona: z.enum(PERSONAS),
    merchantIds: z.array(z.string().regex(/^(\*|mer_[a-z0-9_]{1,60})$/)).max(50).optional(),
    legalEntityIds: z.array(z.string().regex(/^cell_[a-z0-9_]{1,40}$/)).max(20).optional(),
    environments: z.array(z.enum(["TEST", "LIVE"])).min(1).max(2),
    expiresAt: isoDate.optional(),
    reason: z.string().trim().min(10, "Write at least 10 characters").max(500),
  })
  .strict();

export const accessActionBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().max(500).optional(),
    expiresAt: isoDate.optional(),
  })
  .strict();
