import type { AuthorizationTransaction } from "../integrations/oidc.js";
import type { Principal, SessionUser } from "../authorization/principal.js";

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    sso?: AuthorizationTransaction;
  }
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      principal?: Principal;
    }
  }
}

export {};
