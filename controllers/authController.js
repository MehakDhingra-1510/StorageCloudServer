import mongoose, { Types } from "mongoose";
import OTP from "../models/otpModel.js";
import User from "../models/userModel.js";
import Directory from "../models/directoryModel.js";
import { verifyIdToken } from "../services/googleAuthService.js";
import { sendOtpService } from "../services/sendOtpService.js";
import redisClient from "../config/redis.js";
import { SESSION_COOKIE_OPTIONS } from "../config/cookieOptions.js";
import { otpSchema } from "../validators/authSchema.js";

export const sendOtp = async (req, res, next) => {
  const { email } = req.body;
  const resData = await sendOtpService(email);
  res.status(201).json(resData);
};

export const verifyOtp = async (req, res, next) => {
  const { success, data } = otpSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: "Invalid OTP" });
  }

  const email = data.email.toLowerCase().trim();
  const { otp } = data;
  const otpRecord = await OTP.findOne({ email, otp });

  if (!otpRecord) {
    return res.status(400).json({ error: "Invalid or Expired OTP!" });
  }

  // Note: intentionally not deleted here — verifyOtp is a pre-check the
  // client uses to unlock the rest of the registration form; the final
  // register() call re-submits this same OTP and is what actually
  // consumes/deletes it. Deleting it here would make register() fail.
  return res.json({ message: "OTP Verified!" });
};

export const loginWithGoogle = async (req, res, next) => {
  const { idToken } = req.body;
  let userData;
  try {
    userData = await verifyIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: "Invalid Google token." });
  }

  const { name, picture } = userData;
  const email = userData.email.toLowerCase().trim();

  try {
    const user = await User.findOne({ email }).select("-__v");

    if (user) {
      if (user.deleted) {
        return res.status(403).json({
          error: "Your account has been deleted. Contact app owner to recover.",
        });
      }

      const allSessions = await redisClient.ft.search(
        "userIdIdx",
        `@userId:{${user.id}}`,
        {
          RETURN: [],
        }
      );

      if (allSessions.total >= 2) {
        await redisClient.del(allSessions.documents[0].id);
      }

      if (!user.picture.includes("googleusercontent.com")) {
        user.picture = picture;
        await user.save();
      }

      const sessionId = crypto.randomUUID();
      const redisKey = `session:${sessionId}`;
      await redisClient.json.set(redisKey, "$", {
        userId: user._id,
        rootDirId: user.rootDirId,
        role: user.role,
        email: user.email,
      });

      const sessionExpiryTime = 60 * 1000 * 60 * 24 * 7;
      await redisClient.expire(redisKey, sessionExpiryTime / 1000);

      res.cookie("sid", sessionId, {
        ...SESSION_COOKIE_OPTIONS,
        signed: true,
        maxAge: sessionExpiryTime,
      });

      return res.json({ message: "logged in" });
    }

    const mongooseSession = await mongoose.startSession();

    try {
      const rootDirId = new Types.ObjectId();
      const userId = new Types.ObjectId();

      mongooseSession.startTransaction();

      await Directory.insertOne(
        {
          _id: rootDirId,
          name: `root-${email}`,
          parentDirId: null,
          userId,
        },
        { session: mongooseSession }
      );

      await User.insertOne(
        {
          _id: userId,
          name,
          email,
          picture,
          rootDirId,
        },
        { session: mongooseSession }
      );

      const sessionId = crypto.randomUUID();
      const redisKey = `session:${sessionId}`;
      await redisClient.json.set(redisKey, "$", {
        userId,
        rootDirId,
        role: "User",
        email,
      });

      const sessionExpiryTime = 60 * 1000 * 60 * 24 * 7;
      await redisClient.expire(redisKey, sessionExpiryTime / 1000);

      res.cookie("sid", sessionId, {
        ...SESSION_COOKIE_OPTIONS,
        signed: true,
        maxAge: sessionExpiryTime,
      });

      await mongooseSession.commitTransaction();
      return res.status(201).json({ message: "account created and logged in" });
    } catch (err) {
      await mongooseSession.abortTransaction();
      next(err);
    } finally {
      mongooseSession.endSession();
    }
  } catch (err) {
    return next(err);
  }
};