import { LogOut, Settings, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, PageHead } from '../components/Card';
import { InvoicePreview } from '../components/DemoExtras';
import { useApi } from '../hooks/useApi';
import { useSession } from '../hooks/useSession';
import { api } from '../services/api';
import { ApiError } from '../services/http';
import type { Environment } from '../types/api';
import { signOut } from './MiscPages';

interface PrefField { key: string; label: string; type?: 'text' | 'email' | 'tel' | 'url' | 'select' | 'color'; options?: string[]; hint?: string }

type Section = 'personal' | 'branding' | 'portal';

/**
 * A settings card saved on the console server for the signed-in user (TEST,
 * in memory, audited). The server validates every value.
 */
function SettingsCard({ title, section, saved: initial, fields, note, preview, onSaved }: {
  title: string; section: Section; saved?: Record<string, string>; fields: PrefField[]; note: string;
  preview?: (values: Record<string, string>) => ReactNode; onSaved: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const values = { ...(initial ?? {}), ...edits };
  const save = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(undefined);
    api.setPreferences(section, values)
      .then(() => { setStatus({ ok: true, text: 'Saved for your account (TEST).' }); setEdits({}); onSaved(); })
      .catch((err: unknown) => setStatus({ ok: false, text: err instanceof ApiError ? `${err.title}. ${err.detail ?? ''}` : 'The server refused these settings.' }))
      .finally(() => setBusy(false));
  };
  const formId = 'prefs-' + section;
  return <Card title={title} eyebrow="Saved for your account · TEST" footer={<><span className="subtle" role="status" style={{ fontSize: 11, flex: 1, color: status && !status.ok ? 'var(--red)' : undefined }}>{status?.text ?? note}</span><button className="btn btn-sm btn-primary" form={formId} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
    <form id={formId} className="stack" onSubmit={save}>
      {fields.map((field) => {
        const id = formId + '-' + field.key;
        const set = (value: string) => { setStatus(undefined); setEdits((old) => ({ ...old, [field.key]: value })); };
        return <div className="field" key={field.key}>
          <label htmlFor={id}>{field.label}</label>
          {field.type === 'select'
            ? <select id={id} className="select" value={values[field.key] ?? ''} onChange={(event) => set(event.target.value)}><option value="">Choose…</option>{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select>
            : <input id={id} className="input" type={field.type ?? 'text'} maxLength={200} value={values[field.key] ?? (field.type === 'color' ? '#008333' : '')} onChange={(event) => set(event.target.value)} />}
          {field.hint && <span className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>{field.hint}</span>}
        </div>;
      })}
    </form>
    {preview && <div style={{ marginTop: 16 }}>{preview(values)}</div>}
  </Card>;
}

export function WorkspaceSettings() {
  const { me, setEnvironment } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const prefs = useApi((signal) => api.preferences(signal), 'console-preferences');
  if (!me) return null;
  const change = async (environment: Environment) => {
    setBusy(true);setError(undefined);
    try { await setEnvironment(environment); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  return <><PageHead title="Workspace Settings" description="Your signed-in account, authorized environments, and workspace access." />
    <div className="dash-grid-2"><Card title="Account" eyebrow="Verified session"><dl className="kv"><dt>Name</dt><dd>{me.displayName}</dd><dt>Username</dt><dd>{me.username}</dd><dt>Roles</dt><dd>{me.personas.join(', ') || 'No role assigned'}</dd></dl></Card>
      <Card title="Environment"><label className="field">Workspace environment<select className="select" value={me.environment} disabled={busy} onChange={(event) => { void change(event.target.value as Environment); }}>{me.environments.map((environment) => <option key={environment} value={environment}>{environment === 'TEST' ? 'Sandbox (Test)' : 'Live'}</option>)}</select></label>{error && <p className="banner" role="alert">{error}</p>}<p className="subtle" style={{ fontSize: 11, marginTop: 12 }}>Changing environments does not enable a production data source or grant new permissions.</p></Card>
      <Card title="Security"><div className="stack"><p className="row"><ShieldCheck size={19} />Access is enforced by your workspace membership.</p><p className="subtle" style={{ fontSize: 11 }}>Contact your access administrator to change your role. Password changes are available from the signed-out login page.</p><button className="btn" onClick={signOut}><LogOut size={15} />Sign out</button></div></Card>
      <Card title="Appearance"><p className="row"><Settings size={19} />Zoiko Pay · Navy and green</p><p className="subtle" style={{ fontSize: 11, marginTop: 12 }}>The workspace follows the approved Command Center design.</p><Link to="/" className="dash-card-link" style={{ marginTop: 16 }}>Back to Dashboard</Link></Card>
      <SettingsCard title="Personal Details" section="personal" saved={prefs.data?.personal} onSaved={prefs.refetch} note="Your sign-in email and password are managed by Zoiko iD." fields={[
        { key: 'backupEmail', label: 'Backup email', type: 'email' },
        { key: 'phone', label: 'Contact phone', type: 'tel' },
        { key: 'trustedLocation', label: 'Trusted location', hint: 'Sign-ins from elsewhere would ask for an extra check once multi-factor sign-in exists.' },
        { key: 'connectedAccount', label: 'Connected sign-in account', type: 'select', options: ['None', 'Google', 'Microsoft'], hint: 'Company single sign-on is configured by your administrator.' },
      ]} />
      <SettingsCard title="Invoice Branding" section="branding" saved={prefs.data?.branding} onSaved={prefs.refetch} note="Applies to invoices and receipts once an invoicing service exists." preview={(v) => <InvoicePreview color={v.brandColor} footer={v.footer} prefix={v.invoicePrefix} />} fields={[
        { key: 'brandColor', label: 'Brand colour', type: 'color' },
        { key: 'invoicePrefix', label: 'Invoice number prefix', hint: '1–8 capital letters or digits, for example ZPAY' },
        { key: 'footer', label: 'Invoice footer' },
        { key: 'reminders', label: 'Payment reminders', type: 'select', options: ['Off', '3 days before due', 'On the due date', '7 days after due'] },
      ]} />
      <SettingsCard title="Customer Portal" section="portal" saved={prefs.data?.portal} onSaved={prefs.refetch} note="A hosted page where customers manage subscriptions and download invoices." fields={[
        { key: 'portal', label: 'Customer portal', type: 'select', options: ['Off', 'On'] },
        { key: 'canCancel', label: 'Customers can cancel subscriptions', type: 'select', options: ['No', 'Yes, at period end', 'Yes, immediately'] },
        { key: 'returnUrl', label: 'Return URL', type: 'url' },
      ]} />
    </div></>;
}
