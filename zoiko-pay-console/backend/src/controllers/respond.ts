import type { Request, Response } from "express";
import type { CallContext, Services } from "../services/context.js";
import { errors } from "../types/errors.js";

export type DataSourceLabel = "fixture" | "live-service" | "console";

/** Consistent success envelope: { data, meta }. `source` tells the UI whether data is a fixture. */
export function ok(req: Request, res: Response, data: unknown, source: DataSourceLabel, asOf?: string, status = 200): void {
  res.status(status).json({
    data,
    meta: {
      requestId: req.requestId,
      environment: req.principal?.environment ?? null,
      source,
      asOf: asOf ?? new Date().toISOString(),
    },
  });
}

export function ctxOf(req: Request): CallContext {
  if (!req.principal) throw errors.unauthenticated();
  return { principal: req.principal, requestId: req.requestId };
}

export const fixtureAsOf = (s: Services) => s.data.asOf();
