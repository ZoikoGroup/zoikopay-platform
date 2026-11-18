import { Building2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { SsoProviderId, SsoProviderOption } from '../types/api';

function ProviderIcon({ provider }: { provider: SsoProviderId }) {
  if (provider === 'company') return <Building2 size={23} aria-hidden="true" />;
  if (provider === 'microsoft') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z" /><path fill="#7fba00" d="M13 1h10v10H13z" /><path fill="#00a4ef" d="M1 13h10v10H1z" /><path fill="#ffb900" d="M13 13h10v10H13z" /></svg>;
  if (provider === 'google') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.28 1.48-1.13 2.73-2.4 3.57v2.98h3.89c2.28-2.1 3.53-5.2 3.53-8.79Z" /><path fill="#34a853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.89-2.98c-1.07.72-2.45 1.16-4.06 1.16-3.13 0-5.78-2.11-6.73-4.95H1.25v3.08C3.23 21.32 7.3 24 12 24Z" /><path fill="#fbbc05" d="M5.27 14.32a7.22 7.22 0 0 1 0-4.64V6.6H1.25a11.98 11.98 0 0 0 0 10.8l4.02-3.08Z" /><path fill="#ea4335" d="M12 4.73c1.77 0 3.35.61 4.6 1.8l3.45-3.45C17.96 1.13 15.24 0 12 0 7.3 0 3.23 2.68 1.25 6.6l4.02 3.08C6.22 6.84 8.87 4.73 12 4.73Z" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 0c.13 1.43-.41 2.85-1.26 3.89-.9 1.11-2.34 1.97-3.75 1.86-.19-1.37.52-2.86 1.33-3.75C13.62.98 15.14.2 16.4 0ZM20.6 17.59c-.53 1.19-.79 1.72-1.47 2.77-.94 1.47-2.26 3.3-3.9 3.32-1.46.02-1.84-.95-3.82-.94-1.98.01-2.39.96-3.84.94-1.64-.02-2.9-1.68-3.84-3.15C1.1 16.5.29 11.63 1.92 9.06c1.16-1.83 3-2.9 4.74-2.9 1.77 0 2.88.98 4.34.98 1.41 0 2.27-.98 4.33-.98 1.55 0 3.2.84 4.36 2.29-3.83 2.1-3.21 7.58.91 9.14Z" /></svg>;
}
const OPTIONS: { id: SsoProviderId; label: string }[] = [
  { id: 'microsoft', label: 'Continue with Microsoft' }, { id: 'google', label: 'Continue with Google' },
  { id: 'apple', label: 'Continue with Apple' }, { id: 'company', label: 'Company SSO' },
];
const ERRORS: Record<string, string> = {
  SSO_SESSION_EXPIRED: 'This sign-in link expired or could not be verified. Choose a sign-in method again.',
  SSO_CANCELED: 'Single sign-on was canceled. Choose a sign-in method to try again.',
  SSO_FAILED: 'Your identity could not be verified. Try again or use your work email and password.',
  SSO_UNAVAILABLE: 'Single sign-on is temporarily unavailable. Use your work email and password.',
};

/** Native same-origin POST forms initiate login; codes and tokens stay out of application JavaScript. */
export function SignInOptions({ compact = false }: { compact?: boolean }) {
  const [providers, setProviders] = useState<SsoProviderOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState<SsoProviderId>();
  const [callbackError] = useState(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('auth_error');
    return error ? ERRORS[error] : undefined;
  });
  useEffect(() => {
    const controller = new AbortController();
    api.ssoProviders(controller.signal).then((response) => { setProviders(response.data.providers); setLoaded(true); }).catch((error: unknown) => {
      if ((error as Error).name !== 'AbortError') { setFailed(true); setLoaded(true); }
    });
    return () => controller.abort();
  }, []);
  const renderOption = ({ id, label }: typeof OPTIONS[number]) => {
      const enabled = providers.some((provider) => provider.id === id && provider.enabled);
      return <form key={id} method="post" action={'/auth/sso/' + id} onSubmit={(event) => { if (!enabled || starting) event.preventDefault(); else setStarting(id); }}>
        <button className="btn auth-provider-button" type="submit" disabled={!enabled || Boolean(starting)} title={!loaded ? 'Checking sign-in connection…' : !enabled ? 'This sign-in method is not connected to your workspace yet' : undefined}>
          <span className="auth-provider-icon"><ProviderIcon provider={id} /></span>{starting === id ? 'Connecting…' : label}
          {loaded && !enabled && <span className="sr-only"> (not connected)</span>}
        </button>
      </form>;
  };
  return <div className="auth-sso">
    <div className="auth-divider"><span />or continue with<span /></div>
    {callbackError && <p className="auth-sso-error" role="alert">{callbackError}</p>}
    <div className="auth-sso-grid" aria-label="Other sign-in methods">{(compact ? OPTIONS.slice(0, 2) : OPTIONS).map(renderOption)}</div>
    {compact && <details className="auth-more-options"><summary>More sign-in options</summary><div className="auth-sso-grid">{OPTIONS.slice(2).map(renderOption)}</div></details>}
    <p className="auth-sso-availability" role="status">{!loaded ? 'Checking available sign-in methods…' : failed ? 'Single sign-on is temporarily unavailable. Use your email and password.' : !providers.some((provider) => provider.enabled) ? 'Single sign-on is not connected. Use your email and password.' : providers.some((provider) => !provider.enabled) ? 'Unconnected sign-in methods are unavailable for this workspace.' : 'Choose your organization’s sign-in method, or use your email and password.'}</p>
  </div>;
}
