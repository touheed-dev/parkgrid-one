import { Router } from "express";
import { AppError } from "../../lib/errors.js";
import { me, requireAuth } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import * as repo from "./repo.js";
import {
  changePasswordBody, forgotBody, loginBody, logoutBody, refreshBody, resetBody, signupBody,
} from "./schema.js";
import * as service from "./service.js";

export const authRouter: Router = Router();

const ctxOf = (req: { get(name: string): string | undefined; ip?: string | undefined }) => ({
  userAgent: req.get("user-agent") ?? null,
  ip: req.ip ?? null,
});

authRouter.post("/signup", authLimiter, validate({ body: signupBody }), async (req, res) => {
  res.status(201).json(await service.signup(req.body, ctxOf(req)));
});

authRouter.post("/login", authLimiter, validate({ body: loginBody }), async (req, res) => {
  res.json(await service.login(req.body, ctxOf(req)));
});

authRouter.post("/refresh", authLimiter, validate({ body: refreshBody }), async (req, res) => {
  res.json(await service.refresh(req.body.refreshToken, ctxOf(req)));
});

authRouter.post("/logout", validate({ body: logoutBody }), async (req, res) => {
  // Works with only a refresh token (access token may already be expired).
  await service.logout(req.body.refreshToken, null);
  res.json({ success: true });
});

authRouter.post("/logout-all", requireAuth, async (req, res) => {
  await service.logoutAll(me(req).id);
  res.json({ success: true });
});

authRouter.post("/forgot-password", authLimiter, validate({ body: forgotBody }), async (req, res) => {
  await service.forgotPassword(req.body.email);
  // Always the same answer: no account enumeration.
  res.json({ success: true, message: "If an account exists for that email, a reset link has been sent." });
});

authRouter.post("/reset-password", authLimiter, validate({ body: resetBody }), async (req, res) => {
  await service.resetPassword(req.body.token, req.body.password);
  res.json({ success: true });
});

authRouter.post("/change-password", requireAuth, validate({ body: changePasswordBody }), async (req, res) => {
  const user = me(req);
  await service.changePassword(user.id, user.sessionId, req.body.currentPassword, req.body.newPassword);
  res.json({ success: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await repo.findUserById(me(req).id);
  if (!user) throw AppError.unauthorized();
  res.json({ user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name } });
});
