import crypto from "crypto";
import { Resend } from "resend";
import OTP from "../models/otpModel.js";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendOtpService(rawEmail) {
  const email = rawEmail.toLowerCase().trim();
  const otp = crypto.randomInt(1000, 10000).toString();

  // Upsert OTP (replace if it already exists)
  await OTP.findOneAndUpdate(
    { email },
    { otp, createdAt: new Date() },
    { upsert: true }
  );

  const html = `
    <div style="font-family:sans-serif;">
      <h2>Your OTP is: ${otp}</h2>
      <p>This OTP is valid for 10 minutes.</p>
    </div>
  `;

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: email,
    subject: "Storage App OTP",
    html,
  });

  return { success: true, message: `OTP sent successfully on ${email}` };
}