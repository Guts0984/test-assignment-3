import { loginBodySchema, publicUserSchema, registerBodySchema } from "@app/shared";
import { Router } from "express";
import { errorResponse, type RouteDoc } from "../../infra/openapi/build-document";
import { requireSameOrigin, requireUser } from "../../middleware/auth";
import type { AuthController } from "./auth.controller";

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();
  router.post("/auth/register", requireSameOrigin, controller.register);
  router.post("/auth/login", requireSameOrigin, controller.login);
  router.post("/auth/logout", requireSameOrigin, controller.logout);
  router.get("/me", requireUser, controller.me);
  return router;
}

export const authRoutes: RouteDoc[] = [
  {
    method: "post",
    path: "/auth/register",
    summary: "Create an account and log in (sets the httpOnly session cookie)",
    tags: ["Auth"],
    request: { body: registerBodySchema },
    responses: {
      201: { description: "Account created and logged in", schema: publicUserSchema },
      400: errorResponse("Invalid email or password"),
      409: errorResponse("This email is already registered"),
      429: errorResponse("Too many attempts"),
    },
  },
  {
    method: "post",
    path: "/auth/login",
    summary: "Log in (sets the httpOnly session cookie)",
    tags: ["Auth"],
    request: { body: loginBodySchema },
    responses: {
      200: { description: "Logged in", schema: publicUserSchema },
      400: errorResponse("Invalid request"),
      401: errorResponse("Wrong email or password"),
      429: errorResponse("Too many attempts"),
    },
  },
  {
    method: "post",
    path: "/auth/logout",
    summary: "Log out: ends the session and clears the cookie",
    tags: ["Auth"],
    responses: { 204: { description: "Logged out (also when there was no session)" } },
  },
  {
    method: "get",
    path: "/me",
    summary: "The current user",
    tags: ["Auth"],
    requiresSession: true,
    responses: {
      200: { description: "The logged-in user", schema: publicUserSchema },
      401: errorResponse("Not logged in"),
    },
  },
];
