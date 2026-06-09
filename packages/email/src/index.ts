import { once } from "node:events";
import { connect } from "node:net";
import { Resend } from "resend";

export type EmailProvider = "mailpit" | "resend" | "log";

export interface TransactionalEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  idempotencyKey?: string;
}

export function getEmailProvider(): EmailProvider {
  const provider = (process.env.EMAIL_PROVIDER ?? "log").toLowerCase();
  if (provider === "mailpit" || provider === "resend" || provider === "log") return provider;
  throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
}

export function emailIdempotencyKey(parts: string[]): string {
  return parts.map((p) => p.trim().toLowerCase()).join(":");
}

function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function smtpAddress(value: string): string {
  const safe = headerValue(value);
  return safe.match(/<([^>]+)>$/)?.[1] ?? safe;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function smtpData(value: string): string {
  return value.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

async function sendMailpitEmail(email: TransactionalEmail): Promise<void> {
  const host = process.env.MAILPIT_SMTP_HOST ?? "127.0.0.1";
  const port = Number(process.env.MAILPIT_SMTP_PORT ?? 1025);
  const from = process.env.EMAIL_FROM ?? "Companion <no-reply@companion.local>";
  const socket = connect({ host, port });
  socket.setEncoding("utf8");
  let buffer = "";
  let pending: ((value: string) => void) | null = null;
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/).filter(Boolean);
    if (pending && lines.some((line) => /^\d{3} /.test(line))) {
      const resolve = pending;
      pending = null;
      const response = buffer;
      buffer = "";
      resolve(response);
    }
  });
  await once(socket, "connect");
  const read = () =>
    new Promise<string>((resolve) => {
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (lines.some((line) => /^\d{3} /.test(line))) {
        const response = buffer;
        buffer = "";
        resolve(response);
        return;
      }
      pending = resolve;
    });
  const command = async (line: string) => {
    socket.write(`${line}\r\n`);
    const response = await read();
    if (!/^(2|3)\d{2}/.test(response)) throw new Error(`Mailpit SMTP failed: ${response.trim()}`);
  };

  try {
    await read();
    await command("HELO companion.local");
    await command(`MAIL FROM:<${smtpAddress(from)}>`);
    await command(`RCPT TO:<${smtpAddress(email.to)}>`);
    await command("DATA");
    const message = [
      `From: ${headerValue(from)}`,
      `To: ${headerValue(email.to)}`,
      `Subject: ${headerValue(email.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "",
      email.html,
    ].join("\r\n");
    socket.write(`${smtpData(message)}\r\n.\r\n`);
    await read();
    await command("QUIT");
  } finally {
    socket.destroy();
  }
}

export async function sendTransactionalEmail(email: TransactionalEmail): Promise<void> {
  const provider = getEmailProvider();
  if (provider === "log") {
    console.log(`[email:${provider}] ${email.to} ${email.subject}`);
    return;
  }
  if (provider === "mailpit") {
    await sendMailpitEmail(email);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("RESEND_API_KEY and EMAIL_FROM are required for EMAIL_PROVIDER=resend");

  const resend = new Resend(apiKey);
  const result = await resend.emails.send(
    {
      from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    },
    email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : undefined,
  );
  if (result.error) throw new Error(result.error.message);
}

export function inviteEmail(input: { to: string; orgName: string; inviteUrl: string }): TransactionalEmail {
  const orgName = escapeHtml(input.orgName);
  const inviteUrl = escapeHtml(input.inviteUrl);
  return {
    to: input.to,
    subject: `Invitation to ${headerValue(input.orgName)}`,
    html: `<p>You have been invited to ${orgName}.</p><p><a href="${inviteUrl}">Join workspace</a></p>`,
    text: `You have been invited to ${input.orgName}. Join: ${input.inviteUrl}`,
    idempotencyKey: emailIdempotencyKey(["invite", input.orgName, input.to]),
  };
}

/** A 6-digit code rendered as a large, monospace block — the focal point of OTP emails. */
function codeBlock(code: string): string {
  return `<p style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:600;letter-spacing:8px;margin:16px 0">${escapeHtml(code)}</p>`;
}

export function verificationCodeEmail(input: { to: string; code: string }): TransactionalEmail {
  return {
    to: input.to,
    subject: "Your Companion verification code",
    html: `<p>Confirm your email to finish setting up your Companion workspace. Enter this code:</p>${codeBlock(input.code)}<p>The code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>`,
    text: `Your Companion verification code is ${input.code}. It expires in 10 minutes. If you didn't request it, you can ignore this email.`,
    idempotencyKey: emailIdempotencyKey(["verify", input.to, input.code]),
  };
}

export function passwordResetCodeEmail(input: { to: string; code: string }): TransactionalEmail {
  return {
    to: input.to,
    subject: "Reset your Companion password",
    html: `<p>We received a request to reset your Companion password. Enter this code to choose a new one:</p>${codeBlock(input.code)}<p>The code expires in 10 minutes. If you didn't request a reset, you can ignore this email — your password stays the same.</p>`,
    text: `Your Companion password reset code is ${input.code}. It expires in 10 minutes. If you didn't request a reset, you can ignore this email.`,
    idempotencyKey: emailIdempotencyKey(["reset", input.to, input.code]),
  };
}
