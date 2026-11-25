/**
 * Realtime Synchronization Manager for ParkGrid
 *
 * Implements a single, authenticated Socket.IO connection for the app (fed by Postgres LISTEN/NOTIFY).
 *
 * Security & Reliability guarantees:
 * 1. Anonymous users receive zero subscriptions.
 * 2. The handshake carries the access token; the server refuses anonymous sockets and re-checks roles.
 * 3. Events carry ids only (no personal data). Members only ever receive their OWN booking/session/
 *    notification events; admins/staff additionally receive the admin_* events.
 * 4. The fresh token is sent over the socket after every token refresh (no reconnect needed).
 * 5. Debounces query invalidations (~500ms) to coalesce bursts into a single refetch.
 * 6. Pauses refetches while document is hidden; triggers a single batch refetch on visibility.
 * 7. When disconnected, gracefully falls back to 60-second polling (refetchInterval).
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import { API_URL } from "@/lib/api/config";
import { type StoredSession as Session } from "@/lib/auth/session";
import { AVAILABILITY_QUERY_KEY, BOOKINGS_QUERY_KEY, SLOTS_QUERY_KEY } from "@/hooks/useBookings";
import { SESSIONS_QUERY_KEY } from "@/hooks/useSessions";
import { ADMIN_PAYMENTS_QUERY_KEY } from "@/hooks/usePayments";
import { DASHBOARD_STATS_QUERY_KEY } from "@/hooks/useSettings";
import { toast } from "sonner";

export interface RealtimeSyncState {
  isLive: boolean;
  status: "disconnected" | "connecting" | "connected" | "error";
  lastEventAt: Date | null;
}

// Global connection state so any component can inspect connection status without duplicate sockets
let globalIsLive = false;
let globalStatus: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
let globalLastEventAt: Date | null = null;
const statusListeners = new Set<(state: RealtimeSyncState) => void>();

function notifyStatusListeners() {
  const state: RealtimeSyncState = {
    isLive: globalIsLive,
    status: globalStatus,
    lastEventAt: globalLastEventAt,
  };
  statusListeners.forEach((fn) => fn(state));
}

/**
 * Returns fallback polling interval: false if live socket is connected;
 * 60,000 ms (60 seconds) if disconnected or offline.
 */
export function getRealtimeRefetchInterval(
  isLive: boolean,
  fallbackMs: number = 60000,
): number | false {
  return isLive ? false : fallbackMs;
}

/**
 * Hook to inspect the application-wide Realtime connection status.
 */
export function useRealtimeStatus(): RealtimeSyncState {
  const [state, setState] = useState<RealtimeSyncState>({
    isLive: globalIsLive,
    status: globalStatus,
    lastEventAt: globalLastEventAt,
  });

  useEffect(() => {
    statusListeners.add(setState);
    return () => {
      statusListeners.delete(setState);
    };
  }, []);

  return state;
}

// Singleton socket reference
let activeSocket: Socket | null = null;
let activeSessionToken: string | null = null;
let activeUserId: string | null = null;
let activeIsAdmin: boolean = false;

/**
 * Main Realtime Synchronization Hook.
 * Call this once in SiteShell (or top-level layout) to orchestrate the single app connection.
 */
export function useRealtimeSync(session: Session | null, isAdmin: boolean = false) {
  const queryClient = useQueryClient();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInvalidationsRef = useRef<Set<string>>(new Set());
  const isHiddenRef = useRef<boolean>(
    typeof document !== "undefined" ? document.visibilityState === "hidden" : false,
  );

  // ── Debounced Batch Invalidator ──────────────────────────────
  const flushInvalidations = useCallback(() => {
    if (pendingInvalidationsRef.current.size === 0) return;

    const keysToInvalidate = new Set(pendingInvalidationsRef.current);
    pendingInvalidationsRef.current.clear();

    if (keysToInvalidate.has("availability")) {
      queryClient.invalidateQueries({ queryKey: AVAILABILITY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: SLOTS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["slots"] });
    }
    if (keysToInvalidate.has("slots")) {
      queryClient.invalidateQueries({ queryKey: SLOTS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["slots"] });
    }
    if (keysToInvalidate.has("bookings")) {
      queryClient.invalidateQueries({ queryKey: BOOKINGS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
      if (activeIsAdmin) {
        queryClient.invalidateQueries({ queryKey: ["admin", "bookings"] });
      }
    }
    if (keysToInvalidate.has("sessions")) {
      queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (activeIsAdmin) {
        queryClient.invalidateQueries({ queryKey: ["admin", "active_sessions"] });
        queryClient.invalidateQueries({ queryKey: ["admin", "sessions"] });
      }
    }
    if (keysToInvalidate.has("payments")) {
      queryClient.invalidateQueries({ queryKey: ADMIN_PAYMENTS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "payments"] });
    }
    if (keysToInvalidate.has("admin_dashboard")) {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_STATS_QUERY_KEY });
    }
    if (keysToInvalidate.has("notifications")) {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
  }, [queryClient]);

  const scheduleInvalidation = useCallback(
    (keys: string[]) => {
      globalLastEventAt = new Date();
      notifyStatusListeners();

      keys.forEach((k) => pendingInvalidationsRef.current.add(k));

      // If document is currently hidden, pause execution until tab becomes visible
      if (isHiddenRef.current) {
        return;
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        flushInvalidations();
      }, 500); // 500ms debounce
    },
    [flushInvalidations],
  );

  // ── Visibility Change Listener ───────────────────────────────
  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleVisibilityChange = () => {
      const hidden = document.visibilityState === "hidden";
      isHiddenRef.current = hidden;

      if (!hidden && pendingInvalidationsRef.current.size > 0) {
        // Tab became visible again — flush all accumulated changes in a single batch
        flushInvalidations();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushInvalidations]);

  // ── 1. Keep the live socket authenticated after token refreshes ─
  useEffect(() => {
    if (typeof window === "undefined") return;
    const currentToken = session?.accessToken ?? null;
    activeSessionToken = currentToken;
    if (currentToken && activeSocket?.connected) {
      activeSocket.emit("auth", { token: currentToken });
    }
  }, [session?.accessToken]);

  // ── 2. Single Socket.IO connection ──────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    const currentUserId = session?.user?.id ?? null;
    activeUserId = currentUserId;
    activeIsAdmin = isAdmin;

    // Anonymous or logged out -> clean up and stop
    if (!session?.accessToken || !currentUserId) {
      if (activeSocket) {
        activeSocket.close();
        activeSocket = null;
      }
      globalIsLive = false;
      globalStatus = "disconnected";
      notifyStatusListeners();
      return;
    }

    // Already connected for this user: nothing to do
    if (activeSocket) return;

    globalStatus = "connecting";
    notifyStatusListeners();

    const socket = io(API_URL, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      // The server validates this token in the handshake; a fresh one is read on every (re)connect.
      auth: (cb) => cb({ token: activeSessionToken ?? "" }),
      reconnectionDelayMax: 15_000,
    });

    // Privacy-safe availability signal (no user/vehicle data)
    socket.on("availability_changed", () => {
      const keys = ["availability", "slots"];
      if (activeIsAdmin) keys.push("admin_dashboard");
      scheduleInvalidation(keys);
    });

    // Owner's own booking (server only emits this to the owner's room)
    socket.on("booking_changed", () =>
      scheduleInvalidation(["availability", "slots", "bookings", "sessions"]),
    );
    socket.on("session_changed", () =>
      scheduleInvalidation(["availability", "slots", "sessions", "bookings"]),
    );
    socket.on("payment_changed", () => scheduleInvalidation(["payments", "bookings"]));

    // Admin/staff-only events
    socket.on("admin_booking_changed", () =>
      scheduleInvalidation(["bookings", "payments", "sessions", "admin_dashboard"]),
    );
    socket.on("admin_session_changed", () =>
      scheduleInvalidation(["bookings", "sessions", "admin_dashboard"]),
    );
    socket.on("admin_payment_changed", () => scheduleInvalidation(["payments", "admin_dashboard"]));

    socket.on("notification_created", () => {
      toast.info("New notification");
      scheduleInvalidation(["notifications"]);
    });

    socket.on("connect", () => {
      globalIsLive = true;
      globalStatus = "connected";
      notifyStatusListeners();
      // A reconnect may have missed events: refetch once.
      scheduleInvalidation(["availability", "slots", "bookings", "sessions", "notifications"]);
    });
    socket.on("disconnect", () => {
      globalIsLive = false;
      globalStatus = "disconnected";
      notifyStatusListeners();
    });
    socket.on("connect_error", (err) => {
      globalIsLive = false;
      globalStatus = "error";
      notifyStatusListeners();
      console.warn("[RealtimeSync] Connection error:", err.message);
    });

    activeSocket = socket;

    return () => {
      if (activeSocket) {
        activeSocket.close();
        activeSocket = null;
      }
      globalIsLive = false;
      globalStatus = "disconnected";
      notifyStatusListeners();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [session?.user?.id, isAdmin, scheduleInvalidation]);

  return {
    isLive: globalIsLive,
    status: globalStatus,
    lastEventAt: globalLastEventAt,
  };
}
