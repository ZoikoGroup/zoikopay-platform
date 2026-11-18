import type { Request } from 'express';
import { defaultEnvironment, NO_ACCESS_SCOPE } from '../authorization/principal.js';
import type { IdentityClaims } from '../integrations/oidc.js';
import type { Services } from './context.js';

/** Password and SSO login share the same session rotation and local membership rules. */
export async function establishLogin(req: Request, claims: IdentityClaims, services: Services, provider?: string) {
  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  const membership = services.directory.find(claims.sub);
  req.session.user = {
    sub: claims.sub, username: claims.username, displayName: claims.displayName,
    loginAt: services.now(), authTime: claims.authTime, refreshToken: claims.refreshToken,
    environment: defaultEnvironment(membership?.scope ?? NO_ACCESS_SCOPE),
  };
  services.audit.append({ actorSub: claims.sub, actorUsername: claims.username, action: 'auth.login', outcome: 'SUCCEEDED', requestId: req.requestId,
    detail: { membership: membership ? 'found' : 'none', ...(provider ? { provider } : {}) } });
}
