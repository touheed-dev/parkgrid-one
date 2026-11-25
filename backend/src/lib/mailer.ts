import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** In tests we capture mail in memory instead of talking SMTP. */
export const sentMails: MailMessage[] = [];

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
});

/** Fire-and-forget safe: a mail outage must never break a request (e.g. password reset). */
export async function sendMail(message: MailMessage): Promise<void> {
  if (env.NODE_ENV === "test") {
    sentMails.push(message);
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, ...message });
  } catch (err) {
    logger.error({ err: (err as Error).message, to: "[redacted]" }, "failed to send mail");
  }
}
