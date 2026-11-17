import type { Environment } from "../types/domain.js";
import { permissionsFor, type Permission, type Persona } from "./permissions.js";

/**
 * Membership scope as decided by Zoiko Pay, not by the identity provider.
 * 03-05 §11.2: Zoiko iD supplies signed identity; Zoiko Pay must still decide
 * merchant membership and operation entitlement.
 */
export interface Scope {
  kind: "internal" | "merchant";
  legalEntityIds: string[];
  tenantIds: string[] | "*";
  merchantIds: string[] | "*";
  environments: Environment[];
}

export interface Membership {
  sub: string;
  username: string;
  displayName: string;
  personas: Persona[];
  scope: Scope;
}

/** Identity established at sign-in and stored server-side in the session. */
export interface SessionUser {
  sub: string;
  username: string;
  displayName: string;
  loginAt: number; // epoch ms
  authTime: number; // epoch s, from the ID token
  /** Kept server-side only, to revoke the Keycloak session at sign-out. */
  refreshToken?: string;
  /** Epoch seconds of the latest password re-entry (step-up), if any. */
  stepUpAt?: number;
  environment: Environment;
}

/** Everything authorization needs about the caller, resolved per request. */
export interface Principal {
  sub: string;
  username: string;
  displayName: string;
  personas: Persona[];
  permissions: Set<Permission>;
  scope: Scope;
  environment: Environment;
  stepUpAt?: number;
}

export const NO_ACCESS_SCOPE: Scope = {
  kind: "internal", legalEntityIds: [], tenantIds: [], merchantIds: [], environments: [],
};

export function buildPrincipal(user: SessionUser, membership: Membership | undefined): Principal {
  const personas = membership?.personas ?? [];
  return {
    sub: user.sub,
    username: user.username,
    displayName: user.displayName,
    personas,
    permissions: permissionsFor(personas),
    scope: membership?.scope ?? NO_ACCESS_SCOPE,
    environment: user.environment,
    stepUpAt: user.stepUpAt,
  };
}

export function defaultEnvironment(scope: Scope): Environment {
  return scope.environments.includes("TEST") ? "TEST" : (scope.environments[0] ?? "TEST");
}
