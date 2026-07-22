import redisClient from "../config/redis.js";
import { SESSION_COOKIE_OPTIONS } from "../config/cookieOptions.js";

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

  req.user = {
    _id: session.userId,
    rootDirId: session.rootDirId,
    role: session.role,
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
