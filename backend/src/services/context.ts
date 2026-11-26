import type { Principal } from "../authorization/principal.js";
import type { ConsoleDataSource } from "../database/dataSource.js";
import type { MembershipDirectory } from "../integrations/directory.js";
import type { ScreenStore } from "../screens/store.js";
import type { ExceptionalAccessStore } from "./exceptional.js";
import type { AuditLog } from "./audit.js";

/** Shared dependencies every service receives. Built once in app.ts. */
export interface Services {
  data: ConsoleDataSource;
  audit: AuditLog;
  /** Who holds which role: merchant.memberships through the Go gateway (Q39). */
  directory: MembershipDirectory;
  /** Exceptional access grants (ADR 0004). */
  exceptional: ExceptionalAccessStore;
  screens: ScreenStore;
  now: () => number;
}

/** Per-call context: who is asking and for which request. */
export interface CallContext {
  principal: Principal;
  requestId: string;
}

export function auditActor(ctx: CallContext) {
  return {
    actorSub: ctx.principal.sub,
    actorUsername: ctx.principal.username,
    environment: ctx.principal.environment,
    requestId: ctx.requestId,
  };
}
