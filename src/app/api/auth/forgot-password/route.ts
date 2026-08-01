import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/stripe";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";

/**
 * POST /api/auth/forgot-password
 *
 * Accepts { email } and, if a user with that email exists, generates a
 * single-use reset token (random 32 bytes, hex-encoded) valid for 1 hour,
 * then emails them a reset link. For security we return 200 OK regardless
 * of whether the email exists (user enumeration prevention).
 */
export async function POST(request: Request) {
  try {
    const rl = await checkRateLimit(requestKey(request), { namespace: "auth:forgot", limit: 5, windowSec: 60 * 10 });
    if (!rl.allowed) {
      return rl.toResponse('Too many attempts — try again later.');
    }

    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // Always respond identically whether or not the user exists (anti-enumeration).
    if (user && process.env.RESEND_API_KEY) {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken: tokenHash, resetTokenExpires: expires },
      });

      const siteUrl = getSiteUrl();
      const resetLink = `${siteUrl}/reset-password?token=${encodeURIComponent(token)}`;

      const fromEmail = process.env.FROM_EMAIL || "SmartBill <billing@smartbill.app>";
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: fromEmail,
          to: [user.email],
          subject: "Reset your SmartBill password",
          html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px;">
            <h2 style="color:#0f172a;">Reset your password</h2>
            <p style="color:#475569;">We received a request to reset your SmartBill password. Click the button below to choose a new password:</p>
            <p style="margin:24px 0;">
              <a href="${resetLink}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Reset password</a>
            </p>
            <p style="color:#94a3b8;font-size:13px;">This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
            <p style="color:#94a3b8;font-size:12px;">Or paste this into your browser: ${resetLink}</p>
          </body></html>`,
          text: `Reset your SmartBill password\n\nWe received a request to reset your password. Visit the following link to choose a new password:\n\n${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.\n`,
        });
      } catch (err) {
        console.error("[forgot-password] Resend error:", err);
        // Still return 200 to not leak whether the email exists.
      }
    }

    return NextResponse.json({
      success: true,
      message: "If an account exists with that email, a reset link has been sent.",
    });
  } catch (error) {
    console.error("[forgot-password] Failed:", error);
    return NextResponse.json({ error: "Failed to process request." }, { status: 500 });
  }
}
