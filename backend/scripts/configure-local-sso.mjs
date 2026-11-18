// Updates only the existing development console client. Never runs on a remote realm.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const envFile = (path) => existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
const env = {
  ...envFile(fileURLToPath(new URL('../../deploy/compose/.env', import.meta.url))),
  ...envFile(fileURLToPath(new URL('../.env', import.meta.url))),
  ...process.env,
};
const issuer = new URL(env.OIDC_ISSUER ?? 'http://localhost:8180/realms/zoikopay');
const origin = new URL(env.CONSOLE_PUBLIC_ORIGIN ?? 'http://localhost:5173');
const local = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (!local(issuer) || !local(origin) || issuer.pathname !== '/realms/zoikopay') throw new Error('This helper is restricted to the local zoikopay realm.');
const clientId = env.OIDC_CLIENT_ID ?? 'zoikopay-console';
const tokenResponse = await fetch(new URL('/realms/master/protocol/openid-connect/token', issuer), {
  method: 'POST', signal: AbortSignal.timeout(10_000),
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: env.ZP_KEYCLOAK_ADMIN_PASSWORD ?? 'local-dev-only-admin' }),
});
if (!tokenResponse.ok) throw new Error('Local Keycloak administrator authentication failed. Check Docker and the development settings.');
const token = (await tokenResponse.json()).access_token;
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const clientsResponse = await fetch(new URL('/admin/realms/zoikopay/clients?clientId=' + encodeURIComponent(clientId), issuer), { headers, signal: AbortSignal.timeout(10_000) });
if (!clientsResponse.ok) throw new Error('Could not inspect the local console client.');
const clients = await clientsResponse.json();
const client = clients.find((item) => item.clientId === clientId);
if (!client) throw new Error('The local console client is missing. Import the development realm first.');
const response = await fetch(new URL('/admin/realms/zoikopay/clients/' + encodeURIComponent(client.id), issuer), {
  method: 'PUT', headers, signal: AbortSignal.timeout(10_000),
  body: JSON.stringify({ ...client, standardFlowEnabled: true, implicitFlowEnabled: false,
    redirectUris: [...new Set([...(client.redirectUris ?? []), new URL('/auth/sso/callback', origin).href])],
    attributes: { ...client.attributes, 'pkce.code.challenge.method': 'S256' },
  }),
});
if (!response.ok) throw new Error('Could not update the local console authorization-code settings.');
console.log('Local Company SSO enabled: exact callback URI, authorization-code flow, and PKCE S256.');
