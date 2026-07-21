import Directory from "../models/directoryModel.js";
import User from "../models/userModel.js";
import mongoose, { Types } from "mongoose";
import OTP from "../models/otpModel.js";
import redisClient from "../config/redis.js";
import { SESSION_COOKIE_OPTIONS } from "../config/cookieOptions.js";
import { z } from "zod/v4";
import { loginSchema, registerSchema } from "../validators/authSchema.js";

export const register = async (req, res, next) => {
  const { success, data, error } = registerSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: z.flattenError(error).fieldErrors });
  }

  const { name, password, otp } = data;
  const email = data.email.toLowerCase().trim();
  console.log(otp);
  const otpRecord = await OTP.findOne({ email, otp });

  if (!otpRecord) {
    return res.status(400).json({ error: "Invalid or Expired OTP!" });
  }

  await otpRecord.deleteOne();

  const session = await mongoose.startSession();

  try {
    const rootDirId = new Types.ObjectId();
    const userId = new Types.ObjectId();

    session.startTransaction();

    await Directory.insertOne(
      {
        _id: rootDirId,
        name: `root-${email}`,
        parentDirId: null,
        userId,
      },
      { session }
    );

    await User.insertOne(
      {
        _id: userId,
        name,
        email,
        password,
        rootDirId,
      },
      { session }
    );

    await session.commitTransaction();

    res.status(201).json({ message: "User Registered" });
  } catch (err) {
    await session.abortTransaction();
    console.log(err);
    if (err.code === 121) {
      res
        .status(400)
        .json({ error: "Invalid input, please enter valid details" });
    } else if (err.code === 11000) {
      if (err.keyValue.email) {
        return res.status(409).json({
          error: "This email already exists",
          message:
            "A user with this email address already exists. Please try logging in or use a different email.",
        });
      }
    } else {
      next(err);
    }
  } finally {
    session.endSession();
  }
};

export const login = async (req, res, next) => {
  const { success, data } = loginSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: "Invalid Credentials" });
  }

  const { email, password } = data;
  const user = await User.findOne({ email: email.toLowerCase().trim() });

  if (!user) {
    return res.status(404).json({ error: "Invalid Credentials" });
  }

  const isPasswordValid = await user.comparePassword(password);

  if (!isPasswordValid) {
    return res.status(404).json({ error: "Invalid Credentials" });
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
  res.json({ message: "logged in" });
};

export const getAllUsers = async (req, res) => {
  const allUsers = await User.find({ deleted: false }).lean();

  const loggedInUserIds = new Set(
    await Promise.all(
      allUsers.map(async ({ _id }) => {
        const sessions = await redisClient.ft.search(
          "userIdIdx",
          `@userId:{${_id}}`,
          { RETURN: [] }
        );
        return sessions.total > 0 ? _id.toString() : null;
      })
    ).then((ids) => ids.filter(Boolean))
  );

  const transformedUsers = allUsers.map(({ _id, name, email }) => ({
    id: _id,
    name,
    email,
    isLoggedIn: loggedInUserIds.has(_id.toString()),
  }));
  res.status(200).json(transformedUsers);
};

export const getCurrentUser = async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  const rootDir = await Directory.findById(user.rootDirId).lean();
  res.status(200).json({
    name: user.name,
    email: user.email,
    picture: user.picture,
    role: user.role,
    maxStorageInBytes: user.maxStorageInBytes,
    usedStorageInBytes: rootDir.size,
  });
};

export const logout = async (req, res) => {
  const { sid } = req.signedCookies;
  await redisClient.del(`session:${sid}`);
  res.clearCookie("sid", SESSION_COOKIE_OPTIONS);
  res.status(204).end();
};

export const logoutById = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const allSessions = await redisClient.ft.search(
      "userIdIdx",
      `@userId:{${userId}}`,
      { RETURN: [] }
    );
    if (allSessions.total > 0) {
      await redisClient.del(allSessions.documents.map(({ id }) => id));
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

export const logoutAll = async (req, res) => {
  const { sid } = req.signedCookies;
  const session = await redisClient.json.get(`session:${sid}`);
  const allSessions = await redisClient.ft.search(
    "userIdIdx",
    `@userId:{${session.userId}}`,
    {
      RETURN: [],
    }
  );
  await redisClient.del(allSessions.documents.map(({ id }) => id));
  res.status(204).end();
};

export const deleteUser = async (req, res, next) => {
  const { userId } = req.params;
  if (req.user._id.toString() === userId) {
    return res.status(403).json({ error: "You can not delete yourself." });
  }
  try {
    const allSessions = await redisClient.ft.search(
      "userIdIdx",
      `@userId:{${userId}}`,
      { RETURN: [] }
    );
    if (allSessions.total > 0) {
      await redisClient.del(allSessions.documents.map(({ id }) => id));
    }
    await User.findByIdAndUpdate(userId, { deleted: true });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
};