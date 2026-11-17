import type { Envelope } from "../types/api";

/** An RFC 9457 problem returned by the backend. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly fields?: { path: string; message: string }[],
    readonly requestId?: string,
  ) {
    super(detail ?? title);
  }
}

export const UNAUTHENTICATED_EVENT = "zp:unauthenticated";

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && typeof body.code === "string") {
    return new ApiError(res.status, body.code, String(body.title ?? "Request failed"),
      typeof body.detail === "string" ? body.detail : undefined,
      Array.isArray(body.errors) ? (body.errors as { path: string; message: string }[]) : undefined,
      typeof body.requestId === "string" ? body.requestId : undefined);
  }
  return new ApiError(res.status, res.status === 0 ? "NETWORK" : "HTTP_ERROR",
    res.status >= 500 ? "The console backend is unavailable" : `Request failed (${res.status})`);
}

/**
 * Calls the console backend. Cookies are same-origin (the Vite server proxies
 * /api to the backend), so no token is ever handled by JavaScript.
 */
export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<Envelope<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK", "Cannot reach the console backend", "Check that the backend is running on port 4000.");
  }
  if (!res.ok) {
    const err = await toError(res);
    if (err.status === 401 && (err.code === "UNAUTHENTICATED" || err.code === "SESSION_EXPIRED")) {
      window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT, { detail: err.code }));
    }
    throw err;
  }
  return (await res.json()) as Envelope<T>;
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
};

export function qs(params: Record<string, string | number | undefined | null | string[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
