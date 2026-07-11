import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import directoryRoutes from "./routes/directoryRoutes.js";
import fileRoutes from "./routes/fileRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import shareRoutes from "./routes/shareRoutes.js";
import checkAuth from "./middlewares/authMiddleware.js";
import {
  apiLimiter,
  authLimiter,
  sanitizeInput,
  preventParamPollution,
} from "./middlewares/securityMiddleware.js";
import { connectDB } from "./config/db.js";

await connectDB();

const PORT = process.env.PORT || 4000;

const app = express();

// Security headers (CSP, X-Frame-Options, HSTS, etc.)
app.use(helmet());

app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// Strip Mongo operator injection attempts and duplicate-param pollution
// from every request body/query/params before it reaches any route.
app.use(sanitizeInput);
app.use(preventParamPollution);

// Baseline rate limit on all routes; tighter limit on auth-sensitive ones.
app.use(apiLimiter);
app.use("/auth", authLimiter);
app.use("/user/login", authLimiter);
app.use("/user/register", authLimiter);

app.use("/directory", checkAuth, directoryRoutes);
app.use("/file", checkAuth, fileRoutes);
app.use("/", userRoutes);
app.use("/auth", authRoutes);
app.use("/share", shareRoutes);

app.use((err, req, res, next) => {
  console.log(err);
  res.status(err.status || 500).json({ error: err.message || "Something went wrong!" });
});

app.listen(PORT, () => {
  console.log(`Server Started`);
});


// https://stackoverflow.com/questions/18367824/how-to-cancel-http-upload-from-data-events