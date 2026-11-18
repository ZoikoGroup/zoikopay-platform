import { ArrowRight, BookOpen, Check, Eye, EyeOff, Layers3, Lock, Minus, Network, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { SignInOptions } from "../components/SignInOptions";
import { Brand } from "../components/Brand";
import { api } from "../services/api";
import { ApiError } from "../services/http";

type Mode = "signin" | "create" | "change";

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Invalid username or password.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  IDENTITY_PROVIDER_UNAVAILABLE: "Sign-in is temporarily unavailable. Try again shortly.",
  USERNAME_TAKEN: "That username or email is not available.",
  WEAK_PASSWORD: "The password does not meet the policy below.",
  NETWORK: "Cannot reach the console. Check that the backend is running.",
};

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "VALIDATION_FAILED" && err.fields?.length) return err.fields.map((f) => f.message).join(". ") + ".";
    return MESSAGES[err.code] ?? err.title;
  }
  return MESSAGES.NETWORK ?? "Cannot reach the console.";
}

/** Same policy as the Keycloak realm and the backend (shown as you type). */
export const PASSWORD_RULES: { label: string; test: (pw: string, username: string) => boolean }[] = [
  { label: "At least 8 characters", test: (pw) => pw.length >= 8 },
  { label: "An upper-case letter", test: (pw) => /[A-Z]/.test(pw) },
  { label: "A lower-case letter", test: (pw) => /[a-z]/.test(pw) },
  { label: "A digit", test: (pw) => /\d/.test(pw) },
  { label: "A symbol, e.g. @ # !", test: (pw) => /[^A-Za-z0-9]/.test(pw) },
  { label: "Not your username", test: (pw, u) => !u || !pw.toLowerCase().includes(u.toLowerCase()) },
];

function PasswordInput({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-wrap">
        <input id={id} className="input input-lg" type={show ? "text" : "password"} placeholder="Enter your password" autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-pressed={show}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

function PasswordChecklist({ password, username }: { password: string; username: string }) {
  return (
    <ul className="pw-rules" aria-label="Password requirements">
      {PASSWORD_RULES.map((r) => {
        const ok = r.test(password, username);
        return (
          <li key={r.label} data-ok={ok}>
            {ok ? <Check size={12} aria-hidden="true" /> : <Minus size={12} aria-hidden="true" />}
            <span>{r.label}</span><span className="sr-only">{ok ? " (met)" : " (not met)"}</span>
          </li>
        );
      })}
    </ul>
  );
}

const policyOk = (pw: string, u: string) => PASSWORD_RULES.every((r) => r.test(pw, u));

function Field({ id, label, value, onChange, autoComplete, type = "text" }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; type?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input input-lg" type={type} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false}
        value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Banner({ tone, children }: { tone: "error" | "ok"; children: ReactNode }) {
  return (
    <div className="banner" data-tone={tone === "error" ? "strong" : undefined} role={tone === "error" ? "alert" : "status"}>
      {tone === "error" ? <Lock size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

function SignInForm({ onSignedIn, initialError, notice, onChangePassword }: { onSignedIn: () => void; initialError?: string; notice?: string; onChangePassword: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return setError("Enter your username and password.");
    setBusy(true);
    setError(undefined);
    try {
      await api.login(username.trim(), password);
      setPassword("");
      onSignedIn();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {notice && !error && <Banner tone="ok">{notice}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      <Field id="username" label="Work email or username" value={username} onChange={setUsername} autoComplete="username" />
      <PasswordInput id="password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      <div className="auth-options"><span className="row"><Lock size={12} /> Secure workspace sign-in</span><button type="button" onClick={onChangePassword}>Change password?</button></div>
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Signing in…" : <>Log In <ArrowRight size={15} aria-hidden="true" /></>}</button>
    </form>
  );
}

function CreateAccountForm({ onDone }: { onDone: (username: string) => void }) {
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", username: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.firstName.trim() || !f.lastName.trim() || !f.email.trim() || !f.username.trim()) return setError("Fill in every field.");
    if (!policyOk(f.password, f.username)) return setError("The password does not meet every requirement.");
    if (f.password !== f.confirm) return setError("The two passwords do not match.");
    setBusy(true);
    setError(undefined);
    try {
      await api.register({ firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), username: f.username.trim().toLowerCase(), password: f.password });
      onDone(f.username.trim().toLowerCase());
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && <Banner tone="error">{error}</Banner>}
      <div className="detail-grid">
        <Field id="first" label="First name" value={f.firstName} onChange={set("firstName")} autoComplete="given-name" />
        <Field id="last" label="Last name" value={f.lastName} onChange={set("lastName")} autoComplete="family-name" />
      </div>
      <Field id="email" label="Work email" type="email" value={f.email} onChange={set("email")} autoComplete="email" />
      <Field id="new-username" label="Username" value={f.username} onChange={set("username")} autoComplete="username" />
      <PasswordInput id="new-password" label="Password" value={f.password} onChange={set("password")} autoComplete="new-password" />
      <PasswordChecklist password={f.password} username={f.username} />
      <PasswordInput id="confirm-password" label="Confirm password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" />
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      <p className="subtle" style={{ fontSize: "var(--fs-xs)" }}>New accounts have no role. An administrator must assign one before you can see any data.</p>
    </form>
  );
}

function ChangePasswordForm({ onDone }: { onDone: (username: string) => void }) {
  const [f, setF] = useState({ username: "", current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.username.trim() || !f.current) return setError("Enter your username and current password.");
    if (!policyOk(f.next, f.username)) return setError("The new password does not meet every requirement.");
    if (f.next !== f.confirm) return setError("The two new passwords do not match.");
    if (f.next === f.current) return setError("Choose a password different from the current one.");
    setBusy(true);
    setError(undefined);
    try {
      await api.changePassword({ username: f.username.trim(), currentPassword: f.current, newPassword: f.next });
      onDone(f.username.trim());
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && <Banner tone="error">{error}</Banner>}
      <Field id="cp-username" label="Username" value={f.username} onChange={set("username")} autoComplete="username" />
      <PasswordInput id="cp-current" label="Current password" value={f.current} onChange={set("current")} autoComplete="current-password" />
      <PasswordInput id="cp-new" label="New password" value={f.next} onChange={set("next")} autoComplete="new-password" />
      <PasswordChecklist password={f.next} username={f.username} />
      <PasswordInput id="cp-confirm" label="Confirm new password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" />
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
    </form>
  );
}

/**
 * Zoiko Pay's own sign-in page: sign in, create an account, or change a
 * password. Passwords go only to the console backend, which checks them with
 * Zoiko iD (Keycloak).
 */
export function LoginPage({ reason, onSignedIn }: { reason?: string; onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [notice, setNotice] = useState<string>();
  const title = { signin: "Welcome back", create: "Create your account", change: "Change password" }[mode];
  const back = (msg: string) => { setNotice(msg); setMode("signin"); };

  return (
    <main className="login">
      <section className="login-art" aria-label="Zoiko Pay payment operations">
        <Brand light />
        <div className="login-hero-copy">
          <h2>Payments you can prove,<br /><span>from checkout to bank.</span></h2>
          <p>Payment orchestration, four-way reconciliation, double-entry ledger visibility, and evidence-grade financial controls.</p>
          <div className="login-features">
            {[{ Icon: Network, label: <>Payment<br />Orchestration</> }, { Icon: Layers3, label: <>Four-Way<br />Reconciliation</> }, { Icon: BookOpen, label: <>Double-Entry<br />Ledger</> }, { Icon: ShieldCheck, label: <>Jurisdiction<br />Controls</> }].map(({ Icon, label }, i) => <div className="login-feature" key={i}><span><Icon size={26} strokeWidth={1.6} /></span><span>{label}</span></div>)}
          </div>
        </div>
        <div className="login-evidence">
          <h3><ShieldCheck size={25} /> Payment Evidence <span>Sandbox example</span></h3>
          <p>One payment. A traceable journey. Independent evidence at every stage.</p>
          <div className="login-evidence-steps">{['Authorized', 'Captured', 'Settled', 'Reconciled'].map((step) => <div key={step}><Check size={20} /><span>{step}</span><small>Illustrative milestone</small></div>)}</div>
        </div>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-form">
          <div role="tablist" aria-label="Account" className="auth-tabs">
            {(["signin", "create", "change"] as Mode[]).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setNotice(undefined); }}>{{ signin: "Login", create: "Register", change: "Change Password" }[m]}</button>)}
          </div>
          <Brand />
          <div className="auth-heading"><h1 id="login-title">{title}</h1><p className="muted">{mode === 'signin' ? 'Sign in to your Zoiko Pay workspace.' : mode === 'create' ? 'Start with a secure Zoiko iD account.' : 'Verify your current password to choose a new one.'}</p></div>
          {mode === 'signin' && <SignInOptions />}
          {mode === 'signin' && <SignInForm onSignedIn={onSignedIn} notice={notice} onChangePassword={() => setMode('change')} initialError={reason === 'SESSION_EXPIRED' ? 'Your session expired. Sign in again.' : undefined} />}
          {mode === 'create' && <CreateAccountForm onDone={(u) => back('Account ' + u + ' created. Sign in; an administrator must assign your role.')} />}
          {mode === 'change' && <ChangePasswordForm onDone={(u) => back('Password changed for ' + u + '. Sign in with your new password.')} />}
          {mode === 'signin' && <p className="auth-switch">New to Zoiko Pay? <button type="button" onClick={() => setMode('create')}>Register</button></p>}
          <div className="auth-protected"><ShieldCheck size={16} />Protected sign-in · Access is verified for your role</div>
          <p className="auth-provider-note">Sandbox workspace · Payment data after sign-in is TEST data.</p>
          <footer className="auth-footer"><span>Zoiko Pay Operations</span><span>Secure by design</span><span>© {new Date().getFullYear()} Zoiko Pay</span></footer>
        </div>
      </section>
    </main>
  );
}
