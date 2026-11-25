// Browser-only auth session for the ParkGrid API (replaces the former Supabase client).
//
// Tokens live in localStorage ("Remember this terminal" checked) or sessionStorage (unchecked),
// exactly like before. Trade-off (documented in docs/SECURITY.md): script-readable storage is
// exposed to XSS, whereas httpOnly cookies would need CSRF protection and a cookie-aware API.
// We keep the Bearer design the app already had; the access token is short-lived (15 min) and the
// refresh token rotates on every use with reuse detection on the server.
import { API_URL, isBrowser } from "@/lib/api/config";

export type Role = "member" | "staff" | "admin";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  full_name: string | null;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires */
  expiresAt: number;
  user: SessionUser;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: SessionUser;
}

const KEY = "parkgrid.session";
const EXPIRY_SKEW_MS = 30_000;

type Listener = (session: StoredSession | null) => void;
const listeners = new Set<Listener>();
let refreshInFlight: Promise<StoredSession | null> | null = null;

function stores(): Storage[] {
  return isBrowser ? [window.localStorage, window.sessionStorage] : [];
}

function read(): StoredSession | null {
  for (const store of stores()) {
    try {
      const raw = store.getItem(KEY);
      if (raw) return JSON.parse(raw) as StoredSession;
    } catch {
      /* corrupted or blocked storage: treat as signed out */
    }
  }
  return null;
}

function write(session: StoredSession, remember: boolean): void {
  if (!isBrowser) return;
  const [local, sessionStore] = [window.localStorage, window.sessionStorage];
  try {
    (remember ? sessionStore : local).removeItem(KEY);
    (remember ? local : sessionStore).setItem(KEY, JSON.stringify(session));
  } catch {
    /* storage blocked (private mode): session lives in memory for this page only */
    memory = session;
  }
}

let memory: StoredSession | null = null;

function emit(session: StoredSession | null): void {
  for (const l of listeners) l(session);
}

export function clearSession(notify = true): void {
  memory = null;
  for (const store of stores()) {
    try {
      store.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
  if (notify) emit(null);
}

function isRemembered(): boolean {
  try {
    return isBrowser ? window.localStorage.getItem(KEY) !== null : true;
  } catch {
    return true;
  }
}

function toStored(r: TokenResponse): StoredSession {
  return {
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: Date.now() + r.expiresIn * 1000,
    user: r.user,
  };
}

async function authFetch<T>(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; message?: string | undefined }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as
    (T & { error?: { message?: string } }) | null;
  return {
    ok: res.ok,
    status: res.status,
    data: res.ok ? json : null,
    message: json?.error?.message,
  };
}

/** Synchronous peek (no refresh). Safe during SSR: returns null. */
export function peekSession(): StoredSession | null {
  return memory ?? read();
}

/** Rotate the refresh token. Single-flight: concurrent callers share one network request. */
export function refreshSession(): Promise<StoredSession | null> {
  if (!isBrowser) return Promise.resolve(null);
  refreshInFlight ??= (async () => {
    const current = peekSession();
    if (!current) return null;
    try {
      const r = await authFetch<TokenResponse>("/auth/refresh", {
        refreshToken: current.refreshToken,
      });
      if (!r.ok || !r.data) {
        // Definitive rejection (expired / reused / revoked): sign out. Network errors keep the session.
        if (r.status === 401 || r.status === 400) clearSession();
        return null;
      }
      const next = toStored(r.data);
      write(next, isRemembered());
      emit(next);
      return next;
    } catch {
      return null; // offline: keep whatever we have and try again later
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Current session, refreshing the access token first when it is (about to be) expired. */
export async function getSession(): Promise<StoredSession | null> {
  const s = peekSession();
  if (!s) return null;
  if (s.expiresAt - Date.now() > EXPIRY_SKEW_MS) return s;
  return (await refreshSession()) ?? (s.expiresAt > Date.now() ? s : null);
}

export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.accessToken ?? null;
}

export async function signInWithPassword(
  email: string,
  password: string,
  remember: boolean,
): Promise<StoredSession> {
  const r = await authFetch<TokenResponse>("/auth/login", { email, password });
  if (!r.ok || !r.data) throw new Error(r.message ?? "Unable to sign in. Please try again.");
  const session = toStored(r.data);
  write(session, remember);
  emit(session);
  return session;
}

export async function signUpWithPassword(
  input: { email: string; password: string; full_name?: string },
  remember = true,
): Promise<StoredSession> {
  const r = await authFetch<TokenResponse>("/auth/signup", input);
  if (!r.ok || !r.data)
    throw new Error(r.message ?? "Unable to create your account. Please try again.");
  const session = toStored(r.data);
  write(session, remember);
  emit(session);
  return session;
}

export async function signOut(): Promise<void> {
  const s = peekSession();
  clearSession(); // sign out locally first: never block the UI on the network
  if (s) await authFetch("/auth/logout", { refreshToken: s.refreshToken }).catch(() => undefined);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const r = await authFetch("/auth/forgot-password", { email });
  if (!r.ok) throw new Error(r.message ?? "Unable to send the reset email. Please try again.");
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const r = await authFetch("/auth/reset-password", { token, password });
  if (!r.ok)
    throw new Error(r.message ?? "Unable to reset your password. The link may have expired.");
}

/** Subscribe to sign-in / sign-out / token refresh (also fires when another tab changes the session). */
export function onAuthStateChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (isBrowser) {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) emit(read());
  });
}
