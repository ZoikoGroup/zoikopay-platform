import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { apiController } from "../controllers/apiController.js";
import { authController } from "../controllers/authController.js";
import type { AccountAdmin } from "../integrations/accounts.js";
import type { IdentityProvider } from "../integrations/oidc.js";
import { authenticate, requireAny } from "../middleware/auth.js";
import type { Services } from "../services/context.js";
import type { HealthMonitor } from "../services/health.js";
import { SandboxService } from "../services/sandbox.js";
import { NotificationService } from "../services/shell.js";

const limiterProblem = {
  title: "Too many requests", status: 429, code: "RATE_LIMITED", detail: "Slow down and retry shortly.",
};

export function authRoutes(s: Services, idp: IdentityProvider, accounts: AccountAdmin): Router {
  const r = Router();
  const c = authController(s, idp, accounts);
  // Slows password guessing: 10 password checks per minute per client IP.
  r.use(["/login", "/reauth", "/register", "/change-password"], rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
    handler: (_req, res) => { res.status(429).type("application/problem+json").json(limiterProblem); } }));
  r.post("/login", c.login);
  r.post("/reauth", c.reauth);
  r.post("/register", c.register);
  r.post("/change-password", c.changePassword);
  r.post("/logout", c.logout);
  return r;
}

/**
 * Every route below /api/v1 except /health/live requires a session, and each
 * route declares the permission it needs. Services then apply object-level
 * scope checks; the route guard alone is never the whole decision.
 */
export function apiRoutes(s: Services, health: HealthMonitor, accounts: AccountAdmin): Router {
  const r = Router();
  const c = apiController(s, health, new NotificationService(), new SandboxService(), accounts);
  const can = (...p: Parameters<typeof requireAny>[1][]) => requireAny(s, ...p);

  r.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false,
    handler: (_req, res) => { res.status(429).type("application/problem+json").json(limiterProblem); } }));

  r.get("/health/live", (_req, res) => { res.json({ data: { status: "ok" } }); });

  r.use(authenticate(s));
  r.get("/me", c.me);
  r.get("/scope", can("overview.view"), c.scope);
  r.put("/session/environment", c.setEnvironment);

  r.get("/overview/kpis", can("overview.view"), c.kpis);
  r.get("/overview/activity", can("metrics.counts.view"), c.activity);
  r.get("/overview/recent-activity", can("overview.view"), c.recentActivity);

  r.get("/payments", can("payments.read"), c.payments);
  r.get("/payments/:id", can("payments.read"), c.payment);

  r.get("/system/health", can("health.view"), c.systemHealth);
  r.get("/platform/summary", can("area.platform"), c.platformSummary);

  // Console screens ZP-BRW-001 … 014: each screen checks its own area
  // permission, record scope and action rules in ScreenStore.
  r.get("/screens/:screen", c.screen);
  r.get("/screens/:screen/records/:id", c.screenRecord);
  r.post("/screens/:screen/records/:id/actions/:action", c.screenAction);
  r.post("/sandbox/payment-intents", can("area.payment_operations"), c.sandboxIntent);

  r.get("/search", can("overview.view"), c.search);
  r.get("/notifications", c.notifications);
  r.post("/notifications/:id/read", c.markNotificationRead);
  r.get("/audit", can("area.audits"), c.audit);

  // Access: role and delegation administration (02-02 ZP-PER-WF-002).
  r.get("/access/members", can("area.access"), c.accessMembers);
  r.get("/access/members/:sub", can("area.access"), c.accessMember);
  r.get("/access/options", can("area.access"), c.accessOptions);
  r.post("/access/requests", can("area.access"), c.accessRequest);
  r.post("/access/grants/:id/actions/:action", can("area.access"), c.accessAction);

  // Exceptional access (ADR 0004): requests, decisions, and the read-only window.
  r.get("/exceptional-access", can("area.exceptional"), c.xaList);
  r.get("/exceptional-access/options", can("area.exceptional"), c.xaOptions);
  r.post("/exceptional-access", can("area.exceptional"), c.xaRequest);
  r.get("/exceptional-access/:id", can("area.exceptional"), c.xaGet);
  r.post("/exceptional-access/:id/actions/:action", can("area.exceptional"), c.xaAction);
  r.get("/exceptional-access/:id/payments", can("area.exceptional"), c.xaPayments);
  r.get("/exceptional-access/:id/payments/:paymentId", can("area.exceptional"), c.xaPayment);
  return r;
}
