import { Bell } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useDismiss } from "../hooks/ui";
import { useApi } from "../hooks/useApi";
import { areaForScreen } from "../navigation/navConfig";
import { api } from "../services/api";
import { formatRelative } from "../services/format";
import { EmptyState, ErrorState } from "./States";

/** Items awaiting your decision (Business Requirements §07 top bar). Refreshes every 60 s. */
export function NotificationPanel() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const res = useApi((s) => api.notifications(s), "notifications", { refreshMs: 60_000 });
  useDismiss(ref, open, () => setOpen(false));
  const unread = res.data?.filter((n) => !n.read).length ?? 0;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="icon-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
        <Bell size={17} />
        {unread > 0 && <span className="count-dot" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <div className="popover-head">
            <strong style={{ fontSize: "var(--fs-sm)" }}>Awaiting your decision</strong>
            <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{unread} unread</span>
          </div>
          {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !res.data?.length ? (
            <EmptyState title="Nothing needs you">Approvals and reviews you can decide appear here.</EmptyState>
          ) : (
            <ul className="menu-list">
              {res.data.map((n) => {
                const area = areaForScreen(n.screenId);
                return (
                  <li key={n.id}>
                    <button className="menu-item" onClick={async () => {
                      setOpen(false);
                      await api.markNotificationRead(n.id).catch(() => undefined);
                      res.refetch();
                      if (area) navigate(`${area.path}?screen=${n.screenId}&record=${encodeURIComponent(n.recordId)}`);
                    }}>
                      <span className="health-dot" data-ok={!n.read} style={{ marginTop: 6 }} aria-hidden="true" />
                      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}{!n.read && <span className="sr-only"> (unread)</span>}</span>
                        <span className="meta mono">{n.recordId}</span>
                        <span className="meta">{formatRelative(n.at)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
