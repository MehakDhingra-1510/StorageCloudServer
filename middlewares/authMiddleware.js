import redisClient from "../config/redis.js";
import { SESSION_COOKIE_OPTIONS } from "../config/cookieOptions.js";
import User from "../models/userModel.js";

export default async function checkAuth(req, res, next) {
  const { sid } = req.signedCookies;

  if (!sid) {
    res.clearCookie("sid", SESSION_COOKIE_OPTIONS);
    return res.status(401).json({ error: "1 Not logged in!" });
  }

  const session = await redisClient.json.get(`session:${sid}`);

  if (!session) {
    res.clearCookie("sid", SESSION_COOKIE_OPTIONS);
    return res.status(401).json({ error: "2 Not logged in!" });
  }

  const user = await User.findById(session.userId).select("deleted role").lean();
  if (!user || user.deleted) {
    await redisClient.del(`session:${sid}`);
    res.clearCookie("sid", SESSION_COOKIE_OPTIONS);
    return res.status(401).json({ error: "Account deleted or not found." });
  }

  if (user.role !== session.role) {
    await redisClient.del(`session:${sid}`);
    res.clearCookie("sid", SESSION_COOKIE_OPTIONS);
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }

  req.user = {
    _id: session.userId,
    rootDirId: session.rootDirId,
    role: user.role,
    email: session.email,
  };
  next();
}

export const checkNotRegularUser = (req, res, next) => {
  if (req.user.role !== "User") return next();
  res.status(403).json({ error: "You can not access users" });
};

export const checkIsAdminUser = (req, res, next) => {
  if (req.user.role === "Admin") return next();
  res.status(403).json({ error: "You can not delete users" });
};
