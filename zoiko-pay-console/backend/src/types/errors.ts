/**
 * Errors are returned as RFC 9457 problem+json (04-01). `code` is a stable,
 * machine-readable reason the frontend can branch on.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "INVALID_CREDENTIALS"
  | "WEAK_PASSWORD"
  | "USERNAME_TAKEN"
  | "FORBIDDEN"
  | "SELF_APPROVAL_PROHIBITED"
  | "SELF_GRANT_PROHIBITED"
  | "ROLE_EXCEEDS_DELEGATOR"
  | "STEP_UP_REQUIRED"
  | "STALE_VERSION"
  | "INVALID_STATE"
  | "IDEMPOTENCY_CONFLICT"
  | "ENVIRONMENT_NOT_PERMITTED"
  | "LIVE_DATA_UNAVAILABLE"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "ORIGIN_REJECTED"
  | "RATE_LIMITED"
  | "IDENTITY_PROVIDER_UNAVAILABLE"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly title: string,
    readonly detail?: string,
    readonly fields?: { path: string; message: string }[],
  ) {
    super(detail ?? title);
  }
}

export const errors = {
  unauthenticated: () => new AppError(401, "UNAUTHENTICATED", "Sign in required"),
  sessionExpired: () => new AppError(401, "SESSION_EXPIRED", "Your session has expired", "Sign in again to continue."),
  forbidden: (detail = "You do not have permission for this action.") => new AppError(403, "FORBIDDEN", "Not permitted", detail),
  notFound: (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`),
  liveUnavailable: () =>
    new AppError(503, "LIVE_DATA_UNAVAILABLE", "LIVE data is not available",
      "No production integration exists yet. Development fixtures are never served for LIVE."),
};
