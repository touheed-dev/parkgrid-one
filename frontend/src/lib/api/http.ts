// Fetch wrapper for the ParkGrid API: base URL, Bearer token, JSON, timeout, ONE refresh-and-retry on 401,
// and errors normalised to a plain `Error.message` (what the UI already displays).
import { getSession, refreshSession } from "@/lib/auth/session";
import { API_URL, isBrowser } from "./config";

const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string = "ERROR",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

function buildUrl(path: string, query?: Query): string {
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function send(
  method: string,
  path: string,
  opts: RequestOptions,
  token: string | null,
): Promise<Response> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers, signal };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return fetch(buildUrl(path, opts.query), init);
}

async function toError(res: Response): Promise<ApiError> {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  const message =
    json?.error?.message ??
    (res.status >= 500
      ? "Something went wrong. Please try again."
      : `Request failed (${res.status})`);
  return new ApiError(message, res.status, json?.error?.code, json?.error?.details);
}

export async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  if (!isBrowser) {
    // Browser-only by design (tokens live in browser storage). Data hooks never run during SSR.
    throw new ApiError("The API is only available in the browser.", 0, "SSR");
  }
  let session = await getSession();
  let res: Response;
  try {
    res = await send(method, path, opts, session?.accessToken ?? null);
    if (res.status === 401 && session) {
      session = await refreshSession(); // single-flight; retried exactly once
      if (session) res = await send(method, path, opts, session.accessToken);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") {
      throw new ApiError(
        "The request took too long. Please check your connection and try again.",
        0,
        "TIMEOUT",
      );
    }
    throw new ApiError("Unable to reach the server. Please check your connection.", 0, "NETWORK");
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export const http = {
  get: <T>(path: string, query?: Query, opts: RequestOptions = {}) =>
    request<T>("GET", path, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    request<T>("POST", path, { ...opts, body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    request<T>("PATCH", path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    request<T>("PUT", path, { ...opts, body: body ?? {} }),
  delete: <T>(path: string, opts: RequestOptions = {}) => request<T>("DELETE", path, opts),
};
