import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";

/**
 * HS256 (shared-secret) access tokens. We chose HS256 over EdDSA because only this one backend
 * both signs and verifies; asymmetric keys add key-distribution work with no benefit here.
 */
const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = "parkgrid-api";

export interface AccessClaims {
  sub: string;
  role: string;
  sid: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ["HS256"] });
  if (typeof payload.sub !== "string" || typeof payload["role"] !== "string" || typeof payload["sid"] !== "string") {
    throw new Error("Malformed access token");
  }
  return { sub: payload.sub, role: payload["role"], sid: payload["sid"] };
}
