import type { NextFunction, Request, Response } from "express";
import type { Permission } from "../authorization/permissions.js";
import { hasPermission } from "../authorization/policy.js";
import { buildPrincipal } from "../authorization/principal.js";
import type { Services } from "../services/context.js";
import { AppError, errors } from "../types/errors.js";

/** Absolute session lifetime, regardless of activity. */
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

/**
 * Resolves the caller from the server-side session. Identity comes from the
 * Keycloak login; personas and scope come from merchant.memberships through
 * the Go gateway, read again on every request with no cache (Q36 36.19, Q39),
 * so a revoked grant stops working on the next request. Nothing the client
 * sends (headers, query, body) and no token claim is trusted for identity,
 * role, tenant or environment. Fails closed: if grants cannot be read, the
 * request gets 503 and no data.
 */
export function authenticate(s: Services) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.session.user;
    if (!user) return next(errors.unauthenticated());
    if (s.now() - user.loginAt > SESSION_ABSOLUTE_MS) {
      req.session.destroy(() => next(errors.sessionExpired()));
      return;
    }
    let membership;
    try {
      membership = await s.directory.current(user);
    } catch (err) {
      // The identity provider no longer accepts the session: end the console session too.
      if (err instanceof AppError && err.code === "SESSION_EXPIRED") {
        req.session.destroy(() => next(err));
        return;
      }
      return next(err);
    }
    req.principal = buildPrincipal(user, membership);
    next();
  };
}

/** Deny by default: the caller must hold at least one of the permissions. Denials are audited. */
export function requireAny(s: Services, ...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (!p) return next(errors.unauthenticated());
    if (perms.some((perm) => hasPermission(p, perm))) return next();
    s.audit.append({
      actorSub: p.sub, actorUsername: p.username, environment: p.environment, requestId: req.requestId,
      action: `${req.method} ${req.baseUrl}${req.route?.path ?? ""}`, outcome: "DENIED",
      detail: { required: perms.join("|") },
    });
    next(errors.forbidden());
  };
}
