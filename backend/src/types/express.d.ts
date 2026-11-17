import type { Principal, SessionUser } from "../authorization/principal.js";

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
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
