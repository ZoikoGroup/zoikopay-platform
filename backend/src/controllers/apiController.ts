import { setupProgress } from "../services/preferences.js";
import type { Request, Response } from "express";
import { parse } from "../middleware/http.js";
import { auditActor, type Services } from "../services/context.js";
import type { HealthMonitor } from "../services/health.js";
import type { SandboxService } from "../services/sandbox.js";
import type { AccountAdmin } from "../integrations/accounts.js";
import { accessAction, accessActionBody, accessQuery, accessRequestBody, grantId, personSub } from "../validators/access.js";
import { listAudit, search, type NotificationService } from "../services/shell.js";
import { activitySeries, overviewKpis, recentActivity } from "../services/overview.js";
import { getPayment, listPayments } from "../services/payments.js";
import { me, scopeOptions } from "../services/session.js";
import { platformSummary } from "../services/platform.js";
import { xaAction, xaActionBody, xaId, xaListQuery, xaPaymentsQuery, xaRequestBody } from "../validators/exceptional.js";
import { paymentId as paymentIdSchema } from "../validators/payments.js";
import { AppError } from "../types/errors.js";
import { paymentId, paymentListQuery } from "../validators/payments.js";
import { actionBody, actionName, auditQuery, createBody, preferenceBody, preferenceSection, recordId, sandboxBody, screenId, screenQuery, searchQuery } from "../validators/screens.js";
import { environmentBody, overviewQuery } from "../validators/session.js";
import { ctxOf, ok } from "./respond.js";

export function apiController(s: Services, health: HealthMonitor, notifications: NotificationService, sandbox: SandboxService, accounts: AccountAdmin) {
  const asOf = () => s.data.asOf();
  return {
    me: (req: Request, res: Response) => ok(req, res, me(s, ctxOf(req)), "console"),
    scope: (req: Request, res: Response) => ok(req, res, scopeOptions(s, ctxOf(req)), "fixture", asOf()),

    setEnvironment: (req: Request, res: Response) => {
      const ctx = ctxOf(req);
      const { environment } = parse(environmentBody, req.body);
      if (!ctx.principal.scope.environments.includes(environment)) {
        s.audit.append({ ...auditActor(ctx), action: "session.environment", outcome: "DENIED", detail: { requested: environment } });
        throw new AppError(403, "ENVIRONMENT_NOT_PERMITTED", `You are not permitted to use ${environment}`);
      }
      const user = req.session.user;
      if (!user) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
      user.environment = environment;
      s.audit.append({ ...auditActor(ctx), environment, action: "session.environment", outcome: "SUCCEEDED", detail: { from: ctx.principal.environment } });
      ok(req, res, { environment }, "console");
    },

    kpis: (req: Request, res: Response) => ok(req, res, overviewKpis(s, ctxOf(req), parse(overviewQuery, req.query)), "fixture", asOf()),
    activity: (req: Request, res: Response) => ok(req, res, activitySeries(s, ctxOf(req), parse(overviewQuery, req.query)), "fixture", asOf()),
    recentActivity: (req: Request, res: Response) => ok(req, res, recentActivity(s, ctxOf(req)), "fixture", asOf()),

    payments: (req: Request, res: Response) => ok(req, res, listPayments(s, ctxOf(req), parse(paymentListQuery, req.query)), "fixture", asOf()),
    payment: (req: Request, res: Response) => ok(req, res, getPayment(s, ctxOf(req), parse(paymentId, req.params.id)), "fixture", asOf()),

    systemHealth: (req: Request, res: Response) => ok(req, res, health.snapshot(ctxOf(req)), "live-service"),
    platformSummary: (req: Request, res: Response) => ok(req, res, platformSummary(s, ctxOf(req)), "fixture", asOf()),

    screen: (req: Request, res: Response) =>
      ok(req, res, s.screens.list(s, ctxOf(req), parse(screenId, req.params.screen), parse(screenQuery, req.query)), "fixture", asOf()),
    screenRecord: (req: Request, res: Response) =>
      ok(req, res, s.screens.get(s, ctxOf(req), parse(screenId, req.params.screen), parse(recordId, req.params.id)), "fixture", asOf()),
    preferences: (req: Request, res: Response) => ok(req, res, s.preferences.get(ctxOf(req)), "console"),
    setPreferences: (req: Request, res: Response) =>
      ok(req, res, s.preferences.set(s, ctxOf(req), parse(preferenceSection, req.params.section), parse(preferenceBody, req.body)), "console"),
    setupProgress: (req: Request, res: Response) => ok(req, res, setupProgress(s, ctxOf(req)), "console"),
    screenCreate: (req: Request, res: Response) =>
      ok(req, res, s.screens.create(s, ctxOf(req), parse(screenId, req.params.screen), parse(createBody, req.body)), "fixture", asOf(), 201),
    screenAction: (req: Request, res: Response) =>
      ok(req, res, s.screens.act(s, ctxOf(req), parse(screenId, req.params.screen), parse(recordId, req.params.id),
        parse(actionName, req.params.action), parse(actionBody, req.body)), "fixture", asOf()),

    sandboxIntent: (req: Request, res: Response) =>
      ok(req, res, sandbox.preview(s, ctxOf(req), req.get("idempotency-key"), parse(sandboxBody, req.body)), "fixture", undefined, 201),

    search: (req: Request, res: Response) => ok(req, res, search(s, ctxOf(req), parse(searchQuery, req.query).q), "fixture", asOf()),
    notifications: (req: Request, res: Response) => ok(req, res, notifications.list(s, ctxOf(req)), "fixture", asOf()),
    markNotificationRead: (req: Request, res: Response) => {
      const id = parse(searchQuery.shape.q, req.params.id);
      notifications.markRead(s, ctxOf(req), id);
      ok(req, res, { id, read: true }, "console");
    },
    audit: (req: Request, res: Response) => ok(req, res, listAudit(s, ctxOf(req), parse(auditQuery, req.query)), "console"),

    accessMembers: async (req: Request, res: Response) =>
      ok(req, res, await s.access.listMembers(s, ctxOf(req), accounts, parse(accessQuery, req.query)), "console"),
    accessMember: async (req: Request, res: Response) => {
      const sub = parse(personSub, req.params.sub);
      // A person with no grant yet is known only to Zoiko iD; only IAM and Security may look them up.
      const account = s.access.allGrants().some((g) => g.sub === sub) ? undefined
        : (await accounts.listAccounts().catch(() => [])).find((a) => a.sub === sub);
      ok(req, res, s.access.member(s, ctxOf(req), sub, account), "console");
    },
    xaList: (req: Request, res: Response) => ok(req, res, s.exceptional.list(s, ctxOf(req), parse(xaListQuery, req.query)), "console"),
    xaOptions: (req: Request, res: Response) => ok(req, res, s.exceptional.options(s, ctxOf(req)), "fixture", asOf()),
    xaRequest: (req: Request, res: Response) => ok(req, res, s.exceptional.request(s, ctxOf(req), parse(xaRequestBody, req.body)), "console", undefined, 201),
    xaGet: (req: Request, res: Response) => ok(req, res, s.exceptional.get(s, ctxOf(req), parse(xaId, req.params.id)), "console"),
    xaAction: (req: Request, res: Response) =>
      ok(req, res, s.exceptional.act(s, ctxOf(req), parse(xaId, req.params.id), parse(xaAction, req.params.action), parse(xaActionBody, req.body)), "console"),
    xaPayments: (req: Request, res: Response) =>
      ok(req, res, s.exceptional.payments(s, ctxOf(req), parse(xaId, req.params.id), parse(xaPaymentsQuery, req.query)), "fixture", asOf()),
    xaPayment: (req: Request, res: Response) =>
      ok(req, res, s.exceptional.payment(s, ctxOf(req), parse(xaId, req.params.id), parse(paymentIdSchema, req.params.paymentId)), "fixture", asOf()),
    accessOptions: (req: Request, res: Response) => ok(req, res, s.access.requestOptions(s, ctxOf(req)), "fixture", asOf()),
    accessRequest: async (req: Request, res: Response) =>
      ok(req, res, await s.access.request(s, ctxOf(req), accounts, parse(accessRequestBody, req.body)), "console", undefined, 201),
    accessAction: (req: Request, res: Response) =>
      ok(req, res, s.access.act(s, ctxOf(req), parse(grantId, req.params.id), parse(accessAction, req.params.action), parse(accessActionBody, req.body)), "console"),
  };
}
