import { z } from "zod";

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email("Please enter a valid email address"));

// Min 8 and a sane max (argon2 on huge inputs is a DoS vector).
export const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password cannot exceed 128 characters");

const COMMON = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "12345678", "123456789",
  "1234567890", "qwertyui", "qwerty123", "11111111", "00000000", "iloveyou", "admin123",
  "letmein1", "welcome1", "abc12345", "parkgrid", "parking1", "parkgrid1",
]);

export function isTrivialPassword(pw: string, emailAddr?: string): boolean {
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return true;
  if (/^(.)\1+$/.test(pw)) return true; // aaaaaaaa
  if (emailAddr && lower === emailAddr.split("@")[0]?.toLowerCase()) return true;
  return false;
}

export const signupBody = z.strictObject({
  email,
  password,
  full_name: z.string().trim().min(2, "Name must be between 2 and 80 characters").max(80).optional(),
});

export const loginBody = z.strictObject({
  email,
  password: z.string().min(1).max(128),
});

export const refreshBody = z.strictObject({
  refreshToken: z.string().min(20).max(200),
});

export const logoutBody = z.strictObject({
  refreshToken: z.string().min(20).max(200).optional(),
});

export const forgotBody = z.strictObject({ email });

export const resetBody = z.strictObject({
  token: z.string().min(20).max(200),
  password,
});

export const changePasswordBody = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});
