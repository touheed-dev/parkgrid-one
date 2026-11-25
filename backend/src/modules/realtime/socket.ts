import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { corsOrigins } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { authenticateToken, currentIdentity, type AuthUser } from "../../middleware/auth.js";
import { startListener, type DbEvent } from "./listener.js";

interface SocketData {
  user: AuthUser | null;
}

const REVALIDATE_MS = 60_000;

function joinRooms(socket: Socket, user: AuthUser): void {
  for (const room of socket.rooms) if (room !== socket.id) void socket.leave(room);
  void socket.join(`user:${user.id}`);
  void socket.join("public"); // availability: any authenticated user
  if (user.role === "admin" || user.role === "staff") void socket.join("admin");
}

/**
 * Socket.IO fan-out of Postgres NOTIFY events.
 *  - Handshake MUST carry a valid access token (`auth.token`); anonymous sockets are refused,
 *    so there is nothing an anonymous visitor can subscribe to.
 *  - Rooms: user:<id> (own events only), public (availability), admin (staff/admin).
 *  - Members never receive other users' events: user events are emitted ONLY to that user's room.
 *  - The client sends `auth` with a fresh token after every token refresh; roles are re-validated
 *    every minute so a demoted/disabled user loses access without reconnecting.
 */
export function attachRealtime(httpServer: HttpServer): { io: Server; close: () => Promise<void> } {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: corsOrigins, credentials: false },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || !token) {
      next(new Error("UNAUTHORIZED"));
      return;
    }
    try {
      (socket.data as SocketData).user = await authenticateToken(token);
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const data = socket.data as SocketData;
    if (!data.user) {
      socket.disconnect(true);
      return;
    }
    joinRooms(socket, data.user);

    socket.on("auth", async (payload: { token?: unknown }, ack?: (ok: boolean) => void) => {
      try {
        if (typeof payload?.token !== "string") throw new Error("bad token");
        const user = await authenticateToken(payload.token);
        if (user.id !== data.user?.id) throw new Error("identity change is not allowed on a live socket");
        data.user = user;
        joinRooms(socket, user);
        ack?.(true);
      } catch {
        ack?.(false);
        socket.disconnect(true);
      }
    });
  });

  const revalidate = setInterval(() => {
    void (async () => {
      for (const socket of await io.fetchSockets()) {
        const user = (socket.data as SocketData).user;
        if (!user) continue;
        try {
          const fresh = await currentIdentity(user.id);
          if (!fresh || fresh.disabled) {
            socket.disconnect(true);
          } else if (fresh.role !== user.role) {
            (socket.data as SocketData).user = { ...user, role: fresh.role };
            if (fresh.role === "member") socket.leave("admin");
            else socket.join("admin");
          }
        } catch {
          /* transient DB error: keep the socket, re-check next minute */
        }
      }
    })();
  }, REVALIDATE_MS);
  revalidate.unref();

  const emit = (e: DbEvent): void => {
    switch (e.type) {
      case "availability_changed":
        io.to("public").emit("availability_changed", { slot_id: e.slot_id });
        break;
      case "booking_changed":
        if (e.user_id) io.to(`user:${e.user_id}`).emit("booking_changed", { booking_id: e.booking_id });
        io.to("admin").emit("admin_booking_changed", { booking_id: e.booking_id });
        break;
      case "session_changed":
        if (e.user_id) io.to(`user:${e.user_id}`).emit("session_changed", { session_id: e.session_id });
        io.to("admin").emit("admin_session_changed", { session_id: e.session_id });
        break;
      case "notification_created":
        if (e.user_id) io.to(`user:${e.user_id}`).emit("notification_created", {});
        break;
      case "payment_changed":
        if (e.user_id) io.to(`user:${e.user_id}`).emit("payment_changed", {});
        io.to("admin").emit("admin_payment_changed", {});
        break;
      default:
        logger.debug({ type: e.type }, "unhandled realtime event type");
    }
  };

  const listener = startListener(emit);

  return {
    io,
    close: async () => {
      clearInterval(revalidate);
      await listener.stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

