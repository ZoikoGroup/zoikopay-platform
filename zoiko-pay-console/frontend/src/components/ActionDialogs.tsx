import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PHONE_QUERY, useMediaQuery, useNow } from "../hooks/ui";
import { useSession } from "../hooks/useSession";
import { api } from "../services/api";
import { formatTime } from "../services/format";
import { ApiError } from "../services/http";
import type { ActionView, RecordView } from "../types/api";
import { Dialog } from "./Overlay";

/** Step-up: re-enter your password; sensitive actions are then allowed for 5 minutes. */
export function ReauthDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { me, refresh } = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.reauth(password);
      refresh();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "RATE_LIMITED" ? "Too many attempts. Wait a minute." : "Incorrect password.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Confirm your password"
      description="This action changes money or access. Re-enter your password to continue; it stays valid for 5 minutes."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="reauth-form" disabled={busy || !password}>{busy ? "Checking…" : "Confirm"}</button></>}
    >
      <form id="reauth-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="reauth-user">Username</label>
          <input id="reauth-user" className="input" value={me?.username ?? ""} readOnly autoComplete="username" />
        </div>
        <div className="field" data-invalid={!!error}>
          <label htmlFor="reauth-password">Password</label>
          <input id="reauth-password" className="input" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} data-autofocus />
          {error && <span className="field-error" role="alert">{error}</span>}
        </div>
      </form>
    </Dialog>
  );
}

/** Confirms one action on one exact record version. The server re-checks every rule. */
export function ActionDialog({ screenId, record, action, onClose, onDone }: {
  screenId: string;
  record: RecordView;
  action: ActionView;
  onClose: () => void;
  onDone: (r: RecordView) => void;
}) {
  const { me } = useSession();
  const now = useNow(5_000);
  const phone = useMediaQuery(PHONE_QUERY);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [reauth, setReauth] = useState(false);
  const stepUpValid = !!me?.stepUpValidUntil && Date.parse(me.stepUpValidUntil) > now;
  const needsStepUp = action.stepUp && !stepUpValid;
  const reasonOk = !action.reasonRequired || reason.trim().length >= 10;
  const blockedOnPhone = action.stepUp && phone;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.act(screenId, record.id, action.name, { version: record.version, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onDone(r.data);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Unexpected error");
      if (err.code === "STEP_UP_REQUIRED") setReauth(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (reauth) return <ReauthDialog onClose={() => setReauth(false)} onDone={() => setReauth(false)} />;

  return (
    <Dialog
      title={action.label}
      description={`${record.id} · version ${record.version}. ${action.source}.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {needsStepUp && !blockedOnPhone ? (
            <button className="btn btn-primary" onClick={() => setReauth(true)} data-autofocus><KeyRound size={14} aria-hidden="true" /> Confirm password to continue</button>
          ) : (
            <button className="btn btn-primary" disabled={blockedOnPhone || !confirmed || !reasonOk || busy} onClick={submit} data-autofocus>
              {busy ? "Submitting…" : action.label}
            </button>
          )}
        </>
      }
    >
      {blockedOnPhone ? (
        <div className="banner" data-tone="strong" role="alert">
          <span>Sensitive approvals are disabled at phone width because the two-person review context cannot be preserved. Use a larger screen.</span>
        </div>
      ) : (
        <>
          {action.stepUp && stepUpValid && me?.stepUpValidUntil && (
            <div className="banner" role="note"><KeyRound size={16} aria-hidden="true" /><span>Password confirmed until {formatTime(me.stepUpValidUntil)}.</span></div>
          )}
          {action.reasonRequired && (
            <div className="field" data-invalid={reason.length > 0 && !reasonOk}>
              <label htmlFor="action-reason">Reason (required, at least 10 characters)</label>
              <textarea id="action-reason" className="textarea" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I reviewed this exact version{record.requestedByName ? `, raised by ${record.requestedByName},` : ""} and its evidence.</span>
          </label>
        </>
      )}
      {error && error.code !== "STEP_UP_REQUIRED" && (
        <div className="banner" data-tone="strong" role="alert">
          <span><strong>{error.title}.</strong> {error.detail}</span>
        </div>
      )}
    </Dialog>
  );
}
