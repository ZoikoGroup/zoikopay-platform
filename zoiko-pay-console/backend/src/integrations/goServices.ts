/**
 * Probes the Go deployables' /healthz endpoints. This is the one source of
 * live (non-fixture) data available today.
 */
export interface ServiceProbe {
  name: string;
  baseUrl: string;
  ok: boolean;
  httpStatus: number | null;
  status: string; // "ok" | "degraded" | "draining" | "unreachable"
  checks: Record<string, string>; // dependency → "ok" | "error"
  latencyMs: number | null;
  checkedAt: string;
}

export async function probeGoService(name: string, baseUrl: string, timeoutMs = 2000): Promise<ServiceProbe> {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    const latencyMs = Math.round(performance.now() - started);
    const body = (await res.json().catch(() => ({}))) as { status?: unknown; checks?: unknown };
    const checks: Record<string, string> = {};
    if (body.checks && typeof body.checks === "object") {
      for (const [k, v] of Object.entries(body.checks)) checks[k] = v === "ok" ? "ok" : "error";
    }
    const status = typeof body.status === "string" ? body.status : res.ok ? "ok" : "degraded";
    return { name, baseUrl, ok: res.ok && status === "ok", httpStatus: res.status, status, checks, latencyMs, checkedAt };
  } catch {
    return { name, baseUrl, ok: false, httpStatus: null, status: "unreachable", checks: {}, latencyMs: null, checkedAt };
  }
}

export async function probeOidc(issuer: string, timeoutMs = 2000): Promise<ServiceProbe> {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(timeoutMs) });
    return { name: "identity", baseUrl: new URL(issuer).origin, ok: res.ok, httpStatus: res.status, status: res.ok ? "ok" : "degraded",
      checks: {}, latencyMs: Math.round(performance.now() - started), checkedAt };
  } catch {
    return { name: "identity", baseUrl: new URL(issuer).origin, ok: false, httpStatus: null, status: "unreachable", checks: {}, latencyMs: null, checkedAt };
  }
}
