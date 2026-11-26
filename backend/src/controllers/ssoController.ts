import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Config } from '../config.js';
import type { IdentityProvider } from '../integrations/oidc.js';
import type { Services } from '../services/context.js';
import { establishLogin } from '../services/loginSession.js';
import { AppError } from '../types/errors.js';

const PROVIDERS = ['microsoft', 'google', 'apple', 'company'] as const;
type Provider = typeof PROVIDERS[number];
const TTL_MS = 5 * 60 * 1000;
const save = (req: Request) => new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
const sameState = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function ssoController(config: Config, idp: IdentityProvider, services: Services) {
  const available = (provider: Provider) => Boolean(config.sso?.enabled && idp.authorizationRequest && idp.authorizationCallback && (provider === 'company' || config.sso.aliases[provider]));
  const auditFailure = (req: Request, provider: string, reason: string) => services.audit.append({ actorSub: 'anonymous', actorUsername: 'anonymous', action: 'auth.sso', outcome: 'FAILED', requestId: req.requestId, detail: { provider, reason } });
  return {
    providers: (_req: Request, res: Response) => {
      res.json({ data: { providers: PROVIDERS.map((id) => ({ id, enabled: available(id) })) }, meta: { source: 'console' } });
    },
    start: async (req: Request, res: Response) => {
      const raw = req.params.provider;
      if (typeof raw !== 'string' || !PROVIDERS.includes(raw as Provider)) throw new AppError(404, 'NOT_FOUND', 'Sign-in method not found');
      const provider = raw as Provider;
      if (!available(provider) || !idp.authorizationRequest) throw new AppError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'This sign-in method is not connected', 'Use your work account below.');
      const redirectUri = new URL('/auth/sso/callback', config.publicOrigin).href;
      try {
        const transaction = await idp.authorizationRequest(redirectUri, config.sso?.aliases[provider]);
        req.session.sso = { ...transaction, provider, redirectUri, createdAt: services.now() };
        await save(req);
        res.redirect(303, transaction.url);
      } catch {
        auditFailure(req, provider, 'authorization_unavailable');
        res.redirect(303, '/?auth_error=SSO_UNAVAILABLE');
      }
    },
    callback: async (req: Request, res: Response) => {
      const pending = req.session.sso;
      const state = req.query.state;
      if (!pending || typeof state !== 'string' || !sameState(state, pending.state) || services.now() - pending.createdAt > TTL_MS || services.now() < pending.createdAt) {
        auditFailure(req, pending?.provider ?? 'unknown', 'invalid_or_expired_state');
        res.redirect(303, '/?auth_error=SSO_SESSION_EXPIRED');return;
      }
      // Consume before exchanging the code. Failure and replay cannot create a session.
      delete req.session.sso;
      await save(req);
      if (req.query.error || !idp.authorizationCallback) {
        auditFailure(req, pending.provider, 'provider_refused');
        res.redirect(303, '/?auth_error=SSO_CANCELED');return;
      }
      try {
        const callback = new URL(pending.redirectUri);
        callback.search = new URL(req.originalUrl, config.publicOrigin).search;
        const claims = await idp.authorizationCallback(callback, pending);
        await establishLogin(req, claims, services, idp, pending.provider);
        await save(req);
        res.redirect(303, '/');
      } catch {
        auditFailure(req, pending.provider, 'verification_failed');
        res.redirect(303, '/?auth_error=SSO_FAILED');
      }
    },
  };
}
