import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";

// General API rate limiter — applies to all routes.
// Generous enough for normal usage, tight enough to blunt scraping/abuse.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Strict limiter for auth-sensitive routes (login, register, OTP, google login).
// Low ceiling specifically to slow down brute-force / credential-stuffing attempts.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
});

// Strips any keys starting with "$" or containing "." from req.body/query/params
// to prevent MongoDB operator injection (e.g. { "email": { "$gt": "" } }).
export const sanitizeInput = mongoSanitize();

// Prevents HTTP Parameter Pollution (e.g. ?id=1&id=2 resolving unpredictably).
export const preventParamPollution = hpp();
