import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../services/api";
import { ApiError, UNAUTHENTICATED_EVENT } from "../services/http";
import type { Environment, Me, Permission, ScopeOptions } from "../types/api";

export interface Selection {
  merchantId: string;
  legalEntityId: string;
  currency: string;
}

interface SessionState {
  status: "loading" | "signed-out" | "ready" | "error";
  error?: ApiError;
  me?: Me;
  scope?: ScopeOptions;
  selection: Selection;
  /** Increments whenever environment or scope changes; data hooks refetch on it. */
  version: number;
  can: (...perms: Permission[]) => boolean;
  setSelection: (s: Partial<Selection>) => void;
  setEnvironment: (env: Environment) => Promise<void>;
  refresh: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

const STORAGE_KEY = "zp.console.selection";

function loadSelection(): Selection {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return { merchantId: "", legalEntityId: "", currency: "GBP", ...(JSON.parse(raw) as Partial<Selection>) };
  } catch {
    // storage unavailable: fall through to defaults
  }
  return { merchantId: "", legalEntityId: "", currency: "GBP" };
}

export function SessionProvider({ children, initial }: { children: ReactNode; initial?: Partial<SessionState> }) {
  const [status, setStatus] = useState<SessionState["status"]>(initial?.status ?? "loading");
  const [error, setError] = useState<ApiError>();
  const [me, setMe] = useState<Me | undefined>(initial?.me);
  const [scope, setScope] = useState<ScopeOptions | undefined>(initial?.scope);
  const [selection, setSel] = useState<Selection>(initial?.selection ?? loadSelection);
  const [version, setVersion] = useState(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (initial?.status) return; // tests supply state directly
    const ctrl = new AbortController();
    (async () => {
      try {
        const m = (await api.me(ctrl.signal)).data;
        setMe(m);
        if (m.hasAccess && m.permissions.includes("overview.view")) {
          const sc = (await api.scope(ctrl.signal)).data;
          setScope(sc);
          setSel((cur) => {
            const next = { ...cur };
            if (next.merchantId && !sc.merchants.some((x) => x.id === next.merchantId)) next.merchantId = "";
            if (next.legalEntityId && !sc.legalEntities.some((x) => x.id === next.legalEntityId)) next.legalEntityId = "";
            if (sc.currencies.length && !sc.currencies.includes(next.currency)) next.currency = sc.currencies[0] ?? "GBP";
            return next;
          });
        }
        setStatus("ready");
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        const err = e as ApiError;
        if (err.status === 401) setStatus("signed-out");
        else {
          setError(err);
          setStatus("error");
        }
      }
    })();
    return () => ctrl.abort();
  }, [reload, initial?.status]);

  useEffect(() => {
    const onUnauth = () => setStatus("signed-out");
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, []);

  const setSelection = useCallback((s: Partial<Selection>) => {
    setSel((cur) => {
      const next = { ...cur, ...s };
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // per-tab convenience only
      }
      return next;
    });
    setVersion((v) => v + 1);
  }, []);

  const setEnvironment = useCallback(async (env: Environment) => {
    await api.setEnvironment(env);
    setReload((r) => r + 1);
    setVersion((v) => v + 1);
  }, []);

  const value = useMemo<SessionState>(() => {
    const perms = new Set(me?.permissions ?? []);
    return {
      status, error, me, scope, selection, version,
      can: (...p) => p.some((x) => perms.has(x)),
      setSelection, setEnvironment,
      refresh: () => {
        setReload((r) => r + 1);
        setVersion((v) => v + 1);
      },
    };
  }, [status, error, me, scope, selection, version, setSelection, setEnvironment]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
