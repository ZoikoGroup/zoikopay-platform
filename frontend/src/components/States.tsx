import { Clock3, Construction, FlaskConical, Inbox, Lock, RefreshCw, ServerCrash, Wifi } from "lucide-react";
import type { ReactNode } from "react";
import { formatRelative } from "../services/format";
import type { ApiError } from "../services/http";
import type { DataSource } from "../types/api";

export function Skeleton({ height = 16, width = "100%", style }: { height?: number; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height, width, ...style }} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ padding: "12px 16px", display: "grid", gap: 14 }} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={18} width={`${92 - (i % 3) * 9}%`} />
      ))}
    </div>
  );
}

function State({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state" role="status">
      <div className="state-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function EmptyState({ title = "Nothing here yet", children, action }: { title?: string; children?: ReactNode; action?: ReactNode }) {
  return <State icon={<Inbox size={18} />} title={title} action={action}>{children}</State>;
}

export function NoPermission({ children }: { children?: ReactNode }) {
  return (
    <State icon={<Lock size={18} />} title="Not available for your role">
      {children ?? "Your role does not include access to this information."}
    </State>
  );
}

/** Maps backend problem codes to the right state. */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  if (error.status === 403) return <NoPermission />;
  if (error.code === "LIVE_DATA_UNAVAILABLE") {
    return (
      <State icon={<Lock size={18} />} title="LIVE data is not available">
        {error.detail ?? "No production integration exists yet."} Switch to TEST to work with development fixtures.
      </State>
    );
  }
  if (error.status === 404) return <EmptyState title="Not found">{error.detail ?? "This record does not exist or is outside your scope."}</EmptyState>;
  return (
    <State
      icon={error.code === "NETWORK" ? <Wifi size={18} /> : <ServerCrash size={18} />}
      title={error.title}
      action={onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" /> Retry
        </button>
      )}
    >
      {error.detail}
      {error.requestId && <span className="mono subtle"> Request {error.requestId.slice(0, 8)}</span>}
    </State>
  );
}

export function StaleIndicator({ stale, loadedAt, onRefresh }: { stale: boolean; loadedAt?: number; onRefresh?: () => void }) {
  if (!loadedAt) return null;
  return (
    <span className="row" style={{ gap: 6, fontSize: "var(--fs-2xs)" }}>
      {stale ? (
        <span className="badge badge-dashed" title="This data may be out of date">
          <Clock3 size={11} aria-hidden="true" /> STALE · {formatRelative(new Date(loadedAt).toISOString())}
        </span>
      ) : (
        <span className="subtle">Updated {formatRelative(new Date(loadedAt).toISOString())}</span>
      )}
      {onRefresh && (
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onRefresh} aria-label="Refresh">
          <RefreshCw size={13} />
        </button>
      )}
    </span>
  );
}

/** Every data panel says where its numbers come from. */
export function SourceBadge({ source }: { source?: DataSource }) {
  if (!source) return null;
  if (source === "fixture") {
    return (
      <span className="badge badge-dashed" title="Development fixture data. Not production data.">
        <FlaskConical size={11} aria-hidden="true" /> MOCK DATA · DEV
      </span>
    );
  }
  if (source === "live-service") return <span className="badge" title="Measured from running services">LIVE PROBE</span>;
  return null;
}

export function NotBuiltBadge() {
  return (
    <span className="badge badge-dashed">
      <Construction size={11} aria-hidden="true" /> NOT BUILT
    </span>
  );
}
