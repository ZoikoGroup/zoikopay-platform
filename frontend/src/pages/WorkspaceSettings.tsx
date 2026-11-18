import { LogOut, Settings, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Card, PageHead } from '../components/Card';
import { useSession } from '../hooks/useSession';
import type { Environment } from '../types/api';
import { signOut } from './MiscPages';

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
    </div></>;
}
