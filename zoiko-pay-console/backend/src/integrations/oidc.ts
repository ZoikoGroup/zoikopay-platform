import * as client from "openid-client";
import type { Config } from "../config.js";
import { AppError } from "../types/errors.js";

export interface IdentityClaims {
  sub: string;
  username: string;
  displayName: string;
  authTime: number;
  refreshToken?: string;
}

/** What the auth routes need from the identity provider. Swappable in tests. */
export interface IdentityProvider {
  /** Verifies a username and password. Throws AppError INVALID_CREDENTIALS when they are wrong. */
  passwordLogin(username: string, password: string): Promise<IdentityClaims>;
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
    };
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
