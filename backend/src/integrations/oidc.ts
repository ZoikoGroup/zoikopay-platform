import * as client from "openid-client";
import type { Config } from "../config.js";
import { AppError } from "../types/errors.js";

export interface IdentityClaims {
  sub: string;
  username: string;
  displayName: string;
  authTime: number;
  refreshToken?: string;
  /** Kept server-side only; the console calls the Go gateway with it (Q39). Never logged. */
  accessToken?: string;
  /** Epoch ms. */
  accessTokenExpiresAt?: number;
}

/** A renewed access token, and the rotated refresh token when the provider issues one. */
export interface TokenSet {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}
export interface AuthorizationTransaction extends AuthorizationRequest {
  provider: 'microsoft' | 'google' | 'apple' | 'company';
  redirectUri: string;
  createdAt: number;
}

/** What the auth routes need from the identity provider. Swappable in tests. */
export interface IdentityProvider {
  /** Verifies a username and password. Throws AppError INVALID_CREDENTIALS when they are wrong. */
  authorizationRequest?(redirectUri: string, providerAlias?: string): Promise<AuthorizationRequest>;
  authorizationCallback?(url: URL, transaction: AuthorizationTransaction): Promise<IdentityClaims>;
  passwordLogin(username: string, password: string): Promise<IdentityClaims>;
  /**
   * Renews the access token with the refresh token. Throws AppError 401
   * SESSION_EXPIRED when the provider no longer accepts it, 503 when it cannot be reached.
   */
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Ends the identity-provider session. Best effort. */
  logout(refreshToken: string | undefined): Promise<void>;
}

/**
 * Keycloak realm `zoikopay` (local stand-in for Zoiko iD).
 *
 * The console shows its own sign-in form and the backend checks the password
 * with Keycloak (OAuth "password" grant, server to server, confidential
 * client). Tokens never reach the browser. Note: the password grant is
 * discouraged by OAuth 2.1 because the app sees the password; it was chosen
 * so the console has its own login page. See ADR 0003.
 */
export class KeycloakProvider implements IdentityProvider {
  private config?: Promise<client.Configuration>;

  constructor(private readonly cfg: Config) {}

  private configuration(): Promise<client.Configuration> {
    this.config ??= client
      .discovery(new URL(this.cfg.oidc.issuer), this.cfg.oidc.clientId, this.cfg.oidc.clientSecret, undefined,
        // Local Keycloak is plain HTTP. Production issuers must be HTTPS.
        this.cfg.production ? {} : { execute: [client.allowInsecureRequests] })
      .catch((err: unknown) => {
        this.config = undefined; // retry discovery on the next attempt
        throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Sign-in is temporarily unavailable",
          `Could not reach the identity provider: ${(err as Error).message}`);
      });
    return this.config;
  }

  async passwordLogin(username: string, password: string): Promise<IdentityClaims> {
    const config = await this.configuration();
    let tokens;
    try {
      tokens = await client.genericGrantRequest(config, "password", { username, password, scope: "openid profile" });
    } catch (err) {
      const code = (err as { error?: string }).error;
      if (code === "invalid_grant") {
        throw new AppError(401, "INVALID_CREDENTIALS", "Invalid username or password");
      }
      throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Sign-in is temporarily unavailable",
        `The identity provider refused the request${code ? ` (${code})` : ""}.`);
    }
    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new AppError(502, "IDENTITY_PROVIDER_UNAVAILABLE", "Sign-in failed", "The identity token is missing required claims.");
    }
    const name = typeof claims.preferred_username === "string" ? claims.preferred_username : username;
    return {
      sub: claims.sub,
      username: name,
      displayName: typeof claims.name === "string" && claims.name ? claims.name : name,
      authTime: typeof claims.auth_time === "number" ? claims.auth_time : Math.floor(Date.now() / 1000),
      refreshToken: tokens.refresh_token,
      ...accessTokenOf(tokens),
    };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const config = await this.configuration();
    let tokens;
    try {
      tokens = await client.refreshTokenGrant(config, refreshToken);
    } catch (err) {
      if ((err as { error?: string }).error === "invalid_grant") {
        throw new AppError(401, "SESSION_EXPIRED", "Your session has expired", "Sign in again to continue.");
      }
      throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Sign-in is temporarily unavailable", "The identity provider could not renew the session.");
    }
    const at = accessTokenOf(tokens);
    if (!at.accessToken || at.accessTokenExpiresAt === undefined) {
      throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Sign-in is temporarily unavailable", "No access token was returned.");
    }
    return { accessToken: at.accessToken, accessTokenExpiresAt: at.accessTokenExpiresAt, refreshToken: tokens.refresh_token ?? refreshToken };
  }

  async authorizationRequest(redirectUri: string, providerAlias?: string): Promise<AuthorizationRequest> {
    const configuration = await this.configuration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email',
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256', state, nonce,
      ...(providerAlias ? { kc_idp_hint: providerAlias } : {}),
    });
    return { url: url.href, codeVerifier, state, nonce };
  }

  async authorizationCallback(url: URL, transaction: AuthorizationTransaction): Promise<IdentityClaims> {
    try {
      const tokens = await client.authorizationCodeGrant(await this.configuration(), url, {
        pkceCodeVerifier: transaction.codeVerifier, expectedState: transaction.state,
        expectedNonce: transaction.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('Missing subject');
      const username = typeof claims.preferred_username === 'string' ? claims.preferred_username : claims.sub;
      return { sub: claims.sub, username, displayName: typeof claims.name === 'string' && claims.name ? claims.name : username,
        authTime: typeof claims.auth_time === 'number' ? claims.auth_time : Math.floor(Date.now() / 1000), refreshToken: tokens.refresh_token,
        ...accessTokenOf(tokens) };
    } catch {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Sign-in could not be verified');
    }
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    try {
      await client.tokenRevocation(await this.configuration(), refreshToken, { token_type_hint: "refresh_token" });
    } catch {
      // Best effort: the console session is destroyed regardless.
    }
  }
}

/** The access token and its expiry. Without expires_in it counts as expired, so the next request renews it. */
function accessTokenOf(tokens: { access_token?: string; expires_in?: number }): Pick<IdentityClaims, "accessToken" | "accessTokenExpiresAt"> {
  if (!tokens.access_token) return {};
  return { accessToken: tokens.access_token, accessTokenExpiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000 };
}
