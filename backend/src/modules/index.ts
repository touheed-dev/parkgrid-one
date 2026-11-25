import { Router } from "express";
import { adminRouter } from "./admin/routes.js";
import { chatRouter } from "./chat/routes.js";
import { kbRouter } from "./kb/routes.js";
import { authRouter } from "./auth/routes.js";
import { bookingsRouter } from "./bookings/routes.js";
import { gateRouter } from "./gate/routes.js";
import { internalRouter } from "./internal/routes.js";
import { notificationsRouter } from "./notifications/routes.js";
import { parkingRouter } from "./parking/routes.js";
import { paymentsRouter } from "./payments/routes.js";
import { reissueQr } from "./payments/service.js";
import { profileRouter } from "./profile/routes.js";
import { sessionsRouter } from "./sessions/routes.js";
import { vehiclesRouter } from "./vehicles/routes.js";
import { me, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

/** All business routes. Each module owns its own router. */
export const apiRouter: Router = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/profile", profileRouter);
apiRouter.use("/vehicles", vehiclesRouter);
apiRouter.use("/parking", parkingRouter);
apiRouter.use("/bookings", bookingsRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/sessions", sessionsRouter);
apiRouter.use("/gate", gateRouter);
apiRouter.use("/admin/kb", kbRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/api/chat", chatRouter);
apiRouter.use("/internal", internalRouter);

// Owner re-issues the QR pass (old token stops working immediately).
apiRouter.post("/bookings/:id/qr/reissue", requireAuth, validate({ params: z.object({ id: z.uuid() }) }), async (req, res) => {
  res.json(await reissueQr(me(req), (req.params as unknown as { id: string }).id));
});
