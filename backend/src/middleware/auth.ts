import type { NextFunction, Request, Response } from "express";
import type { Permission } from "../authorization/permissions.js";
import { hasPermission } from "../authorization/policy.js";
import { buildPrincipal } from "../authorization/principal.js";
import type { Services } from "../services/context.js";
import { errors } from "../types/errors.js";

/** Absolute session lifetime, regardless of activity. */
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

/**
 * Resolves the caller from the server-side session. Identity comes from the
 * Keycloak login; personas and scope come from the Zoiko Pay membership
 * directory. Nothing the client sends (headers, query, body) is trusted for
 * identity, role, tenant or environment.
 */
export function authenticate(s: Services) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.session.user;
    if (!user) return next(errors.unauthenticated());
    if (s.now() - user.loginAt > SESSION_ABSOLUTE_MS) {
      req.session.destroy(() => next(errors.sessionExpired()));
      return;
    }
    req.principal = buildPrincipal(user, s.directory.find(user.sub));
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
