import express from "express";
import validateIdMiddleware from "../middlewares/validateIdMiddleware.js";
import {
  deleteFile,
  getFile,
  permanentlyDeleteFile,
  renameFile,
  restoreFile,
  uploadInitiate,
  uploadComplete
} from "../controllers/fileController.js";

const router = express.Router();

router.param("parentDirId", validateIdMiddleware);
router.param("id", validateIdMiddleware);

router.post("/upload/initiate", uploadInitiate);
router.post("/upload/complete", uploadComplete);

router.get("/:id", getFile);

router.patch("/:id", renameFile);
router.patch("/:id/restore", restoreFile);

router.delete("/:id", deleteFile);
router.delete("/:id/permanent", permanentlyDeleteFile);

export default router;
