import { AppError } from "../types/errors.js";
import { auditActor, type CallContext, type Services } from "./context.js";

/**
 * Access screen (02-02 ZP-PER-WF-002, role and delegation administration).
 *
 * Grants live only in merchant.memberships, owned by BC-01 in Go, and Go has
 * no grant administration yet (Q36 36.11, 36.15). The console's earlier
 * in-memory grant list is gone: a grant made there looked real but gave
 * nobody access. So every read and write here is refused, and audited, until
 * the Go API exists (OPEN_QUESTIONS Q39). The route guard (area.access) still
 * runs first, so roles without the Access area get 403, not this.
 */
export function grantAdministrationUnavailable(s: Services, ctx: CallContext, action: string): never {
  s.audit.append({ ...auditActor(ctx), action, outcome: "FAILED", detail: { reason: "GRANT_ADMINISTRATION_UNAVAILABLE" } });
  throw new AppError(503, "GRANT_ADMINISTRATION_UNAVAILABLE", "Role administration is not available yet",
    "Roles are granted in Zoiko Pay's membership service, which has no grant administration yet. Nothing on this screen can change anyone's access.");
}
