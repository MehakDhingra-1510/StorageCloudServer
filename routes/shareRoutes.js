import express from "express";
import validateIdMiddleware from "../middlewares/validateIdMiddleware.js";
import checkAuth from "../middlewares/authMiddleware.js";
import {
  createShare,
  listSharedByMe,
  listSharedWithMe,
  revokeShare,
  updateShareRole,
  accessSharedLink,
} from "../controllers/shareController.js";

const router = express.Router();

router.param("id", validateIdMiddleware);

// Public — guest access via direct link, no login required.
router.get("/link/:token", accessSharedLink);

// Everything below requires an authenticated user (the owner or a recipient).
router.post("/", checkAuth, createShare);
router.get("/shared-by-me", checkAuth, listSharedByMe);
router.get("/shared-with-me", checkAuth, listSharedWithMe);
router.patch("/:id", checkAuth, updateShareRole);
router.delete("/:id", checkAuth, revokeShare);

export default router;
