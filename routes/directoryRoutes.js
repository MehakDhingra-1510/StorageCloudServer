import express from "express";
import validateIdMiddleware from "../middlewares/validateIdMiddleware.js";

import {
  createDirectory,
  deleteDirectory,
  getDirectory,
  moveDirectory,
  permanentlyDeleteDirectory,
  renameDirectory,
  restoreDirectory,
  searchDirectory
} from "../controllers/directoryController.js";
import { getTrash } from "../controllers/fileController.js";

const router = express.Router();

router.param("parentDirId", validateIdMiddleware);
router.param("id", validateIdMiddleware);
router.get("/search/items", searchDirectory);
router.get("/trash/items", getTrash);
router.get("/:id?", getDirectory);

router.post("/:parentDirId?", createDirectory);

router.patch("/:id", renameDirectory);
router.patch("/:id/restore", restoreDirectory);
router.patch("/:id/move", moveDirectory);

router.delete("/:id", deleteDirectory);
router.delete("/:id/permanent", permanentlyDeleteDirectory);

export default router;