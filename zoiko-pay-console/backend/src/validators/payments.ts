import { z } from "zod";
import { INTENT_STATUSES } from "../types/domain.js";

const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.split(",").filter(Boolean) : v), z.array(item).max(10));

export const paymentListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  status: csv(z.enum(INTENT_STATUSES)).optional(),
  merchantId: z.string().regex(/^mer_[a-z0-9_]{1,60}$/).optional(),
  legalEntityId: z.string().regex(/^cell_[a-z0-9_]{1,40}$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  sort: z.enum(["createdAt", "amount"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaymentListQuery = z.infer<typeof paymentListQuery>;

export const paymentId = z.string().regex(/^pi_[0-9a-f]{32}$/, "must be a pi_ identifier");
