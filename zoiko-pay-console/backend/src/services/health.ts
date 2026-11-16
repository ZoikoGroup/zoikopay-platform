import type { Logger } from "pino";
import { hasPermission } from "../authorization/policy.js";
import { probeGoService, probeOidc, type ServiceProbe } from "../integrations/goServices.js";
import { errors } from "../types/errors.js";
import type { CallContext } from "./context.js";

type Category = "api" | "connector" | "core" | "identity" | "console";

const CATEGORY: Record<string, Category> = {
  gateway: "api", mockpsp: "connector", execution: "core", finance: "core", governance: "core", "outbox-relay": "core",
};

const WINDOW = 120; // samples kept per service for availability

/**
 * Polls every dependency on a fixed interval and keeps a rolling window of
 * results, so availability is measured, not assumed. Availability is since this
 * console backend started (in memory), not an SLO measurement.
 */
export class HealthMonitor {
  private latest = new Map<string, ServiceProbe>();
  private history = new Map<string, boolean[]>();
  private timer?: NodeJS.Timeout;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly services: { name: string; baseUrl: string }[],
    private readonly oidcIssuer: string,
    private readonly log: Logger,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async pollOnce(): Promise<void> {
    const probes = await Promise.all([
      ...this.services.map((s) => probeGoService(s.name, s.baseUrl)),
      probeOidc(this.oidcIssuer),
    ]);
    for (const p of probes) {
      const prev = this.latest.get(p.name);
      if (prev && prev.ok !== p.ok) this.log.warn({ service: p.name, status: p.status }, "dependency health changed");
      this.latest.set(p.name, p);
      const h = this.history.get(p.name) ?? [];
      h.push(p.ok);
      if (h.length > WINDOW) h.shift();
      this.history.set(p.name, h);
    }
  }

  snapshot(ctx: CallContext) {
    if (!hasPermission(ctx.principal, "health.view")) throw errors.forbidden();
    const services = [...this.latest.values()].map((p) => {
      const h = this.history.get(p.name) ?? [];
      const up = h.filter(Boolean).length;
      return {
        name: p.name,
        category: p.name === "identity" ? ("identity" as const) : (CATEGORY[p.name] ?? ("core" as const)),
        status: p.status,
        ok: p.ok,
        checks: p.checks,
        latencyMs: p.latencyMs,
        checkedAt: p.checkedAt,
        availability: h.length ? { percent: Math.round((up * 1000) / h.length) / 10, samples: h.length } : null,
      };
    });
    // Database health as reported by the Go services' own postgres checks.
    const pg = services.flatMap((s) => (s.checks.postgres ? [s.checks.postgres] : []));
    const database = pg.length === 0 ? "unknown" : pg.every((v) => v === "ok") ? "ok" : pg.some((v) => v === "ok") ? "degraded" : "error";
    const lastCheck = services.map((s) => s.checkedAt).sort().at(-1) ?? null;
    return {
      source: "live-service" as const,
      monitoringSince: this.startedAt,
      lastCheck,
      intervalSeconds: this.intervalMs / 1000,
      database: { status: database, reportedBy: services.filter((s) => s.checks.postgres).map((s) => s.name) },
      services: [...services, { name: "console-backend", category: "console" as const, status: "ok", ok: true, checks: {}, latencyMs: 0,
        checkedAt: new Date().toISOString(), availability: null }],
    };
  }
}
