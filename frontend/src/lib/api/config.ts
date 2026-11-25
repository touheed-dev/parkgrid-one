/** Base URL of the ParkGrid API (Express). Only public values live in VITE_ variables. */
export const API_URL: string =
  (import.meta.env["VITE_API_URL"] as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:4000";

export const isBrowser = typeof window !== "undefined";
