import { loginBodySchema, registerBodySchema } from "@app/shared";
import { parseCookie } from "cookie";
import type { CookieOptions, RequestHandler, Response } from "express";
import { SESSION_COOKIE, getCurrentUser } from "../../middleware/auth";
import { getClient } from "../../middleware/client-ip";
import { validated } from "../../middleware/validate";
import type { AuthResult, AuthService } from "./auth.service";
import type { LoginGuard } from "./login-guard";

export interface AuthController {
  register: RequestHandler;
  login: RequestHandler;
  logout: RequestHandler;
  me: RequestHandler;
}

export interface AuthControllerDeps {
  auth: AuthService;
  cookieSecure: boolean;
  loginGuard: LoginGuard;
}

export function createAuthController({ auth, cookieSecure, loginGuard }: AuthControllerDeps): AuthController {
  // httpOnly: page scripts cannot read it. SameSite=Lax: other sites cannot send it on forms.
  const cookieOptions: CookieOptions = { httpOnly: true, sameSite: "lax", secure: cookieSecure, path: "/" };

  const sendSession = (res: Response, status: number, { user, sessionId, ttlSeconds }: AuthResult) => {
    res.cookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge: ttlSeconds * 1000 });
    res.status(status).json(user);
  };

  return {
    register: validated({ body: registerBodySchema }, async ({ body }, _req, res) => {
      sendSession(res, 201, await auth.register(body));
    }),

    login: validated({ body: loginBodySchema }, async ({ body }, _req, res) => {
      await loginGuard.before(getClient(res).ip, body.email);
      const result = await auth.login(body);
      await loginGuard.succeeded(body.email);
      sendSession(res, 200, result);
    }),

    logout: async (req, res) => {
      const sessionId = parseCookie(req.headers.cookie ?? "")[SESSION_COOKIE];
      if (sessionId) await auth.logout(sessionId);
      res.clearCookie(SESSION_COOKIE, cookieOptions);
      res.status(204).end();
    },

    me: (_req, res) => {
      // requireUser runs before this handler, so a user is always present.
      res.json(getCurrentUser(res));
    },
  };
}
