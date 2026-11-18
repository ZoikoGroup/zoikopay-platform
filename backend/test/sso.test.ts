import request from 'supertest';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { describe, expect, it } from 'vitest';
import type { AuthorizationRequest, AuthorizationTransaction, IdentityClaims } from '../src/integrations/oidc.js';
import { FakeIdp, makeTestApp, ORIGIN, PASSWORD } from './helpers.js';

class SsoIdp extends FakeIdp {
  requested: { redirectUri: string; alias?: string }[] = [];
  exchanged: AuthorizationTransaction[] = [];
  subject = 'ops.agent';
  fail = false;
  async authorizationRequest(redirectUri: string, alias?: string): Promise<AuthorizationRequest> {
    this.requested.push({ redirectUri, alias });
    return { url: 'https://idp.test/authorize?state=transaction-state', state: 'transaction-state', nonce: 'bound-nonce', codeVerifier: 'server-only-verifier' };
  }
  async authorizationCallback(_url: URL, transaction: AuthorizationTransaction): Promise<IdentityClaims> {
    this.exchanged.push(transaction);
    if (this.fail) throw new Error('Invalid nonce');
    return this.passwordLogin(this.subject, PASSWORD);
  }
}
function setup(now?: () => number) {
  const idp = new SsoIdp();
  const t = makeTestApp({ idp, now, config: { sso: { enabled: true, aliases: { google: 'approved-google' } } } });
  const agent = request.agent(t.app);
  const begin = () => agent.post('/auth/sso/company').set('Origin', ORIGIN);
  const finish = (state = 'transaction-state') => agent.get('/auth/sso/callback').query({ state, code: 'single-use-code' });
  return { ...t, idp, agent, begin, finish };
}

describe('authorization-code SSO', () => {
  it('publishes only server-configured providers and rejects unavailable or unknown options', async () => {
    const t = setup();
    const list = await t.agent.get('/auth/providers');
    expect(list.body.data.providers).toEqual([{ id: 'microsoft', enabled: false }, { id: 'google', enabled: true }, { id: 'apple', enabled: false }, { id: 'company', enabled: true }]);
    expect((await t.agent.post('/auth/sso/apple').set('Origin', ORIGIN)).status).toBe(503);
    expect((await t.agent.post('/auth/sso/unknown').set('Origin', ORIGIN)).status).toBe(404);
    expect(t.idp.requested).toHaveLength(0);
  });
  it('omits callback codes, state and referrers from request logs', async () => {
    const logs: string[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => { logs.push(line); } });
    const t = makeTestApp({ log });
    await request(t.app).get('/auth/sso/callback?code=private-authorization-code&state=private-state').set('Referer', 'https://idp.test/?state=private-referrer');
    const output = logs.join('');
    expect(output).toContain('/auth/sso/callback');
    for (const value of ['private-authorization-code', 'private-state', 'private-referrer']) expect(output).not.toContain(value);
  });
  it('requires explicit SSO activation in production and accepts only broker aliases', () => {
    const env = { NODE_ENV: 'production', OIDC_ISSUER: 'https://idp.test/realms/zoikopay', OIDC_CLIENT_ID: 'console', OIDC_CLIENT_SECRET: 'test-secret', SESSION_SECRET: 'a-valid-testing-secret-of-at-least-32-characters', ACCOUNT_ADMIN_CLIENT_SECRET: 'rotated-test-only-secret' };
    expect(loadConfig(env).sso?.enabled).toBe(false);
    expect(loadConfig({ ...env, OIDC_SSO_ENABLED: 'true', OIDC_SSO_GOOGLE_ALIAS: 'approved-google' }).sso?.aliases.google).toBe('approved-google');
    expect(() => loadConfig({ ...env, OIDC_SSO_GOOGLE_ALIAS: 'https://evil.test' })).toThrow();
  });
  it('requires a same-origin POST to initiate sign-in', async () => {
    const t = setup();
    expect((await t.agent.get('/auth/sso/company')).status).toBe(404);
    expect((await t.agent.post('/auth/sso/company')).status).toBe(403);
    expect((await t.agent.post('/auth/sso/company').set('Origin', 'https://evil.test')).status).toBe(403);
    expect(t.idp.requested).toHaveLength(0);
  });
  it('binds the fixed callback and provider alias on the server', async () => {
    const t = setup();
    const res = await t.agent.post('/auth/sso/google').set('Origin', ORIGIN).send({ redirectUri: 'https://evil.test', providerAlias: 'attacker' });
    expect(res.status).toBe(303);
    expect(t.idp.requested[0]).toEqual({ redirectUri: ORIGIN + '/auth/sso/callback', alias: 'approved-google' });
    expect(JSON.stringify(res.body) + res.text).not.toContain('server-only-verifier');
  });
  it('rotates the session, resolves local membership and keeps tokens server-side', async () => {
    const t = setup();
    const start = await t.begin();const completed = await t.finish();
    expect(completed.status).toBe(303);
    expect(completed.headers.location).toBe('/');
    expect(completed.headers['set-cookie']?.[0]).not.toBe(start.headers['set-cookie']?.[0]);
    const me = await t.agent.get('/api/v1/me');
    expect(me.body.data).toMatchObject({ username: 'ops.agent', personas: ['POR'], environment: 'TEST' });
    expect(JSON.stringify(me.body)).not.toContain('rt-ops.agent');
    expect(t.idp.exchanged[0]?.codeVerifier).toBe('server-only-verifier');
    expect(t.services.audit.list({ action: 'auth.login', outcome: 'SUCCEEDED' })).toHaveLength(1);
  });
  it('rejects missing, foreign and malformed state without exchanging a code', async () => {
    const t = setup();
    expect((await t.finish()).headers.location).toContain('SSO_SESSION_EXPIRED');
    await t.begin();
    for (const state of ['wrong-state', 'é'.repeat(17)]) expect((await t.finish(state)).headers.location).toContain('SSO_SESSION_EXPIRED');
    expect(t.idp.exchanged).toHaveLength(0);
    expect((await t.agent.get('/api/v1/me')).status).toBe(401);
  });
  it('expires authorization attempts after five minutes', async () => {
    let now = Date.now();const t = setup(() => now);
    await t.begin();now += 5 * 60 * 1000 + 1;
    expect((await t.finish()).headers.location).toContain('SSO_SESSION_EXPIRED');
    expect(t.idp.exchanged).toHaveLength(0);
  });
  it('rejects callback replay after successful login', async () => {
    const t = setup();await t.begin();await t.finish();
    expect((await t.finish()).headers.location).toContain('SSO_SESSION_EXPIRED');
    expect(t.idp.exchanged).toHaveLength(1);
  });
  it('fails closed when token/nonce verification fails and consumes the attempt', async () => {
    const t = setup();t.idp.fail = true;await t.begin();
    expect((await t.finish()).headers.location).toContain('SSO_FAILED');
    expect((await t.agent.get('/api/v1/me')).status).toBe(401);
    expect((await t.finish()).headers.location).toContain('SSO_SESSION_EXPIRED');
  });
  it('handles a provider cancellation without creating a session', async () => {
    const t = setup();await t.begin();
    const res = await t.agent.get('/auth/sso/callback').query({ state: 'transaction-state', error: 'access_denied' });
    expect(res.headers.location).toContain('SSO_CANCELED');
    expect(t.idp.exchanged).toHaveLength(0);
  });
  it('does not assign roles based on an external identity or matching email', async () => {
    const t = setup();t.idp.subject = 'external.user';
    t.idp.extraUsers.set('external.user', { sub: 'unregistered-subject', username: 'external.user', displayName: 'External', authTime: Math.floor(Date.now() / 1000) });
    await t.begin();await t.finish();
    expect((await t.agent.get('/api/v1/me')).body.data).toMatchObject({ hasAccess: false, permissions: [], personas: [] });
    expect((await t.agent.get('/api/v1/payments')).status).toBe(403);
  });
});
