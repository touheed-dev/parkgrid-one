// Client-side route guard helpers.
// Called from beforeLoad in protected routes to redirect unauthenticated visitors to /login with a
// ?redirect= param so they return to the right page.
//
// The browser decides only what to SHOW. Every API call is authorised again on the server
// (Bearer token + role re-read from the database), so a tampered client gains nothing.
import { redirect } from "@tanstack/react-router";
import { getSession, type Role } from "@/lib/auth/session";
import { http } from "@/lib/api/http";

function sanitizeRedirectTarget(pathname: string, fallback = "/"): string {
  if (
    typeof pathname === "string" &&
    pathname.startsWith("/") &&
    !pathname.startsWith("//") &&
    !pathname.includes(":") &&
    !pathname.includes("\\")
  ) {
    return pathname;
  }
  return fallback;
}

const ROLE_TTL_MS = 20_000;
let cachedRole: { userId: string; role: Role; at: number } | null = null;

/** Current role from the server (cached briefly), so a demotion is noticed within seconds. */
async function currentRole(userId: string, fallback: Role): Promise<Role> {
  if (cachedRole && cachedRole.userId === userId && Date.now() - cachedRole.at < ROLE_TTL_MS)
    return cachedRole.role;
  try {
    const { user } = await http.get<{ user: { role: Role } }>("/auth/me");
    cachedRole = { userId, role: user.role, at: Date.now() };
    return user.role;
  } catch {
    return fallback;
  }
}

export function forgetCachedRole(): void {
  cachedRole = null;
}

function toLogin(pathname: string, fallback: string) {
  const redirectTo = sanitizeRedirectTarget(pathname, fallback);
  return redirectTo === "/"
    ? redirect({ to: "/login", replace: true })
    : redirect({ to: "/login", search: { redirect: redirectTo }, replace: true });
}

export async function requireAuthGuard(location: { pathname: string }) {
  // During SSR there is no browser storage. The SiteShell client gate handles the redirect after hydration.
  if (typeof window === "undefined") return;

  const session = await getSession();
  if (!session) throw toLogin(location.pathname, "/");

  // Admin users should only access the admin portal, not member protected routes
  const role = await currentRole(session.user.id, session.user.role);
  if (role === "admin") throw redirect({ to: "/admin", replace: true });
}

export async function requireAdminGuard(location: { pathname: string }) {
  if (typeof window === "undefined") return;

  const session = await getSession();
  if (!session) throw toLogin(location.pathname, "/admin");

  const role = await currentRole(session.user.id, session.user.role);
  if (role !== "admin") throw redirect({ to: "/" });
}

/** Gate scanner: staff and admins only. */
export async function requireStaffGuard(location: { pathname: string }) {
  if (typeof window === "undefined") return;

  const session = await getSession();
  if (!session) throw toLogin(location.pathname, "/gate");

  const role = await currentRole(session.user.id, session.user.role);
  if (role !== "staff" && role !== "admin") throw redirect({ to: "/" });
}
