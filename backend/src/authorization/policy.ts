import type { ScopedResource } from "../types/domain.js";
import type { Permission } from "./permissions.js";
import type { Principal } from "./principal.js";

export function hasPermission(p: Principal, perm: Permission): boolean {
  return p.permissions.has(perm);
}

/**
 * Object-level check: tenant, legal entity, merchant and environment.
 * The environment must be both allowed for the principal and the one the
 * principal currently has selected, so TEST and LIVE never mix in one view.
 * Resource ownership comes from the stored record, never from the request.
 */
export function inScope(p: Principal, r: ScopedResource): boolean {
  const s = p.scope;
  if (r.environment !== p.environment || !s.environments.includes(r.environment)) return false;
  if (!s.legalEntityIds.includes(r.legalEntityId)) return false;
  if (!s.tenantIds.includes(r.tenantId)) return false;
  if (s.merchantIds !== "*" && !s.merchantIds.includes(r.merchantId)) return false;
  return true;
}

/** Permission and scope together: the only way a record may be read. */
export function canRead(p: Principal, perm: Permission, r: ScopedResource): boolean {
  return hasPermission(p, perm) && inScope(p, r);
}
