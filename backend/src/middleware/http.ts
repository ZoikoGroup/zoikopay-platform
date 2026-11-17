import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { AppError } from "../types/errors.js";

/** Assigns a request id, echoed in X-Request-Id and in every response body. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

/**
 * CSRF defense for cookie sessions: every state-changing request must come
 * from the console's own origin. Combined with SameSite=Lax cookies.
 */
export function originCheck(publicOrigin: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (origin !== publicOrigin) {
      return next(new AppError(403, "ORIGIN_REJECTED", "Request origin not allowed",
        "State-changing requests must come from the console."));
    }
    next();
  };
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(400, "VALIDATION_FAILED", "Invalid request", "One or more fields are invalid.",
      r.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })));
  }
  return r.data;
}

/** RFC 9457 problem+json for every error. Unexpected errors never leak detail. */
export function errorHandler(log: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    let e: AppError;
    if (err instanceof AppError) {
      e = err;
    } else if (err instanceof SyntaxError && "body" in err) {
      e = new AppError(400, "VALIDATION_FAILED", "Malformed JSON body");
    } else if ((err as { type?: string }).type === "entity.too.large") {
      e = new AppError(413, "VALIDATION_FAILED", "Request body too large");
    } else {
      log.error({ err, requestId: req.requestId }, "unhandled error");
      e = new AppError(500, "INTERNAL", "Unexpected error", "The request failed. Quote the request id to support.");
    }
    res.status(e.status).type("application/problem+json").json({
      type: `https://docs.zoikopay.example/errors/${e.code.toLowerCase()}`,
      title: e.title,
      status: e.status,
      code: e.code,
      ...(e.detail ? { detail: e.detail } : {}),
      ...(e.fields ? { errors: e.fields } : {}),
      requestId: req.requestId,
    });
  };
}

export function notFoundRoute(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, "NOT_FOUND", "Route not found"));
}
