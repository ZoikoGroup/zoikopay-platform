import type { Request } from 'express';
import { defaultEnvironment, NO_ACCESS_SCOPE, type SessionUser } from '../authorization/principal.js';
import type { IdentityClaims, IdentityProvider } from '../integrations/oidc.js';
import type { Services } from './context.js';

/**
 * Password and SSO login share the same session rotation and membership rules.
 *
 * Grants are read from the gateway before the session exists (Q39). If they
 * cannot be read, sign-in fails closed: no console session is created and the
 * identity-provider session is ended. Tokens stay in the server-side session.
 */
export async function establishLogin(req: Request, claims: IdentityClaims, services: Services, idp: IdentityProvider, provider?: string) {
  const user: SessionUser = {
    sub: claims.sub, username: claims.username, displayName: claims.displayName,
    loginAt: services.now(), authTime: claims.authTime, refreshToken: claims.refreshToken,
    accessToken: claims.accessToken, accessTokenExpiresAt: claims.accessTokenExpiresAt,
    environment: 'TEST',
  };
  let membership;
  try {
    membership = await services.directory.current(user);
  } catch (err) {
    await idp.logout(user.refreshToken);
    services.audit.append({ actorSub: claims.sub, actorUsername: claims.username, action: 'auth.login', outcome: 'FAILED', requestId: req.requestId,
      detail: { reason: 'membership_unavailable', ...(provider ? { provider } : {}) } });
    throw err;
  }
  user.environment = defaultEnvironment(membership?.scope ?? NO_ACCESS_SCOPE);
  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.user = user;
  services.audit.append({ actorSub: claims.sub, actorUsername: claims.username, action: 'auth.login', outcome: 'SUCCEEDED', requestId: req.requestId,
    detail: { membership: membership ? 'found' : 'none', ...(provider ? { provider } : {}) } });
}
