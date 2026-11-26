import type { Request, Response } from "express";
import { establishLogin } from "../services/loginSession.js";
import type { AccountAdmin } from "../integrations/accounts.js";
import type { IdentityProvider } from "../integrations/oidc.js";
import { parse } from "../middleware/http.js";
import type { Services } from "../services/context.js";
import { AppError } from "../types/errors.js";
import { reauthBody } from "../validators/screens.js";
import { changePasswordBody, loginBody, registerBody } from "../validators/session.js";

export function authController(s: Services, idp: IdentityProvider, accounts: AccountAdmin) {
  return {
    /** POST /auth/login { username, password } from the console's own sign-in form. */
    login: async (req: Request, res: Response) => {
      const { username, password } = parse(loginBody, req.body);
      let claims;
      try {
        claims = await idp.passwordLogin(username, password);
      } catch (err) {
        // Failed attempts are audited without the password.
        s.audit.append({ actorSub: "anonymous", actorUsername: username.slice(0, 120), action: "auth.login", outcome: "FAILED",
          requestId: req.requestId, detail: { reason: err instanceof AppError ? err.code : "error" } });
        throw err;
      }

      await establishLogin(req, claims, s, idp);
      res.json({ data: { username: claims.username }, meta: { requestId: req.requestId, source: "console" } });
    },

    /**
     * POST /auth/reauth { password }: step-up. The signed-in user re-enters
     * their password; Keycloak verifies it; sensitive actions are then allowed
     * for 5 minutes.
     */
    reauth: async (req: Request, res: Response) => {
      const user = req.session.user;
      if (!user) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
      const { password } = parse(reauthBody, req.body);
      let claims;
      try {
        claims = await idp.passwordLogin(user.username, password);
      } catch (err) {
        s.audit.append({ actorSub: user.sub, actorUsername: user.username, action: "auth.step_up", outcome: "FAILED", requestId: req.requestId,
          detail: { reason: err instanceof AppError ? err.code : "error" } });
        throw err;
      }
      if (claims.sub !== user.sub) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid username or password");
      user.stepUpAt = Math.floor(s.now() / 1000);
      s.audit.append({ actorSub: user.sub, actorUsername: user.username, action: "auth.step_up", outcome: "SUCCEEDED", requestId: req.requestId });
      res.json({ data: { stepUpValidUntil: new Date((user.stepUpAt + 300) * 1000).toISOString() }, meta: { requestId: req.requestId, source: "console" } });
    },

    /**
     * POST /auth/register: create an account with a username and password.
     * The account gets no role: an administrator must grant one before the
     * console shows any data (deny by default).
     */
    register: async (req: Request, res: Response) => {
      const b = parse(registerBody, req.body);
      try {
        await accounts.createAccount(b);
      } catch (err) {
        s.audit.append({ actorSub: "anonymous", actorUsername: b.username, action: "account.create", outcome: "FAILED", requestId: req.requestId,
          detail: { reason: err instanceof AppError ? err.code : "error" } });
        throw err;
      }
      s.audit.append({ actorSub: "anonymous", actorUsername: b.username, action: "account.create", outcome: "SUCCEEDED", requestId: req.requestId,
        detail: { role: "none" } });
      res.status(201).json({ data: { username: b.username, access: "none until an administrator assigns a role" }, meta: { requestId: req.requestId, source: "console" } });
    },

    /** POST /auth/change-password: verify the current password, then set a new one. */
    changePassword: async (req: Request, res: Response) => {
      const b = parse(changePasswordBody, req.body);
      let claims;
      try {
        claims = await idp.passwordLogin(b.username, b.currentPassword);
      } catch (err) {
        s.audit.append({ actorSub: "anonymous", actorUsername: b.username.slice(0, 120), action: "account.password_change", outcome: "FAILED",
          requestId: req.requestId, detail: { reason: err instanceof AppError ? err.code : "error" } });
        throw err;
      }
      await accounts.setPassword(claims.username, b.newPassword);
      await idp.logout(claims.refreshToken); // the verification session is not kept
      s.audit.append({ actorSub: claims.sub, actorUsername: claims.username, action: "account.password_change", outcome: "SUCCEEDED", requestId: req.requestId });
      res.json({ data: { changed: true }, meta: { requestId: req.requestId, source: "console" } });
    },

    /** POST /auth/logout: ends the console session and the Keycloak session. */
    logout: async (req: Request, res: Response) => {
      const user = req.session.user;
      if (user) {
        await idp.logout(user.refreshToken);
        s.audit.append({ actorSub: user.sub, actorUsername: user.username, action: "auth.logout", outcome: "SUCCEEDED", requestId: req.requestId });
      }
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      res.clearCookie("zp_console_sid", { path: "/" });
      res.json({ data: { signedOut: true }, meta: { requestId: req.requestId, source: "console" } });
    },
  };
}
