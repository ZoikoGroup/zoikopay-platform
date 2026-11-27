import { LogOut, Settings, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, PageHead } from '../components/Card';
import { InvoicePreview } from '../components/DemoExtras';
import { useSession } from '../hooks/useSession';
import type { Environment } from '../types/api';
import { signOut } from './MiscPages';

interface PrefField { key: string; label: string; type?: 'text' | 'email' | 'tel' | 'url' | 'select' | 'color'; options?: string[]; hint?: string }

function readPrefs(key: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  } catch {
    return {};
  }
}

/**
 * A settings form with no server API yet (Stripe personal details, invoice
 * branding, customer portal). Saved in this browser only, and labelled so.
 */
function LocalSettingsCard({ title, storageKey, fields, note, preview }: { title: string; storageKey: string; fields: PrefField[]; note: string; preview?: (values: Record<string, string>) => ReactNode }) {
  const [values, setValues] = useState<Record<string, string>>(() => readPrefs(storageKey));
  const [saved, setSaved] = useState(false);
  const save = (event: FormEvent) => {
    event.preventDefault();
    try { localStorage.setItem(storageKey, JSON.stringify(values)); } catch { /* storage blocked */ }
    setSaved(true);
  };
  const formId = 'prefs-' + storageKey.replace(/\W/g, '-');
  return <Card title={title} eyebrow="Saved in this browser only" footer={<><span className="subtle" style={{ fontSize: 11, flex: 1 }}>{saved ? 'Saved on this device. Not sent to the server.' : note}</span><button className="btn btn-sm btn-primary" form={formId}>Save</button></>}>
    <form id={formId} className="stack" onSubmit={save}>
      {fields.map((field) => {
        const id = formId + '-' + field.key;
        const set = (value: string) => { setSaved(false); setValues((old) => ({ ...old, [field.key]: value })); };
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
      <LocalSettingsCard title="Personal Details" storageKey="zp.console.prefs.personal" note="Your sign-in email and password are managed by Zoiko iD." fields={[
        { key: 'backupEmail', label: 'Backup email', type: 'email' },
        { key: 'phone', label: 'Contact phone', type: 'tel' },
        { key: 'trustedLocation', label: 'Trusted location', hint: 'Sign-ins from elsewhere would ask for an extra check once multi-factor sign-in exists.' },
        { key: 'connectedAccount', label: 'Connected sign-in account', type: 'select', options: ['None', 'Google', 'Microsoft'], hint: 'Company single sign-on is configured by your administrator.' },
      ]} />
      <LocalSettingsCard title="Invoice Branding" storageKey="zp.console.prefs.branding" note="Applies to invoices and receipts once an invoicing service exists." preview={(v) => <InvoicePreview color={v.brandColor} footer={v.footer} prefix={v.invoicePrefix} />} fields={[
        { key: 'brandColor', label: 'Brand colour', type: 'color' },
        { key: 'invoicePrefix', label: 'Invoice number prefix', hint: 'For example ZPAY' },
        { key: 'footer', label: 'Invoice footer' },
        { key: 'reminders', label: 'Payment reminders', type: 'select', options: ['Off', '3 days before due', 'On the due date', '7 days after due'] },
      ]} />
      <LocalSettingsCard title="Customer Portal" storageKey="zp.console.prefs.portal" note="A hosted page where customers manage subscriptions and download invoices." fields={[
        { key: 'portal', label: 'Customer portal', type: 'select', options: ['Off', 'On'] },
        { key: 'canCancel', label: 'Customers can cancel subscriptions', type: 'select', options: ['No', 'Yes, at period end', 'Yes, immediately'] },
        { key: 'returnUrl', label: 'Return URL', type: 'url' },
      ]} />
    </div></>;
}
