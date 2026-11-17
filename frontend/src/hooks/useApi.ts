import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../services/http";
import type { Envelope, Meta } from "../types/api";
import { useSession } from "./useSession";

/** Data older than this is shown with a "stale" indicator. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export interface ApiState<T> {
  data?: T;
  meta?: Meta;
  error?: ApiError;
  loading: boolean;
  /** True once data was loaded and is older than STALE_AFTER_MS (or a refresh failed). */
  stale: boolean;
  loadedAt?: number;
  refetch: () => void;
}

/**
 * Loads data and refetches when `key` or the session scope version changes.
 * Keeps the previous data visible while reloading, and marks it stale when a
 * refresh fails or it ages past STALE_AFTER_MS.
 */
export function useApi<T>(
  fetcher: ((signal: AbortSignal) => Promise<Envelope<T>>) | null,
  key: string,
  opts: { refreshMs?: number } = {},
): ApiState<T> {
  const { version } = useSession();
  const [state, setState] = useState<Omit<ApiState<T>, "refetch" | "stale"> & { failedRefresh: boolean }>({ loading: !!fetcher, failedRefresh: false });
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const fetcherRef = useRef(fetcher);
  const enabled = !!fetcher;

  // Declared before the fetch effect so it always runs first.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const f = fetcherRef.current;
    if (!f) {
      setState({ loading: false, failedRefresh: false });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    f(ctrl.signal)
      .then((env) => setState({ data: env.data, meta: env.meta, loading: false, loadedAt: Date.now(), failedRefresh: false }))
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        const err = e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Unexpected error");
        // Keep data from the same query visible but flag it as stale.
        setState((s) => ({ ...s, loading: false, error: err, failedRefresh: s.data !== undefined }));
      });
    return () => ctrl.abort();
  }, [key, version, tick, enabled]);

  useEffect(() => {
    if (!opts.refreshMs) return;
    const id = setInterval(() => setTick((t) => t + 1), opts.refreshMs);
    return () => clearInterval(id);
  }, [opts.refreshMs]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const stale = state.failedRefresh || (state.loadedAt !== undefined && now - state.loadedAt > STALE_AFTER_MS);
  return { data: state.data, meta: state.meta, error: state.failedRefresh ? undefined : state.error, loading: state.loading, loadedAt: state.loadedAt, stale, refetch };
}
