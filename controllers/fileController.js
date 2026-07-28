import path from "path";
import Directory from "../models/directoryModel.js";
import File from "../models/fileModel.js";
import User from "../models/userModel.js";
import { createGetSignedUrl, createUploadSignedUrl, deleteObject, getObjectMetadata } from "../config/s3.js";
import { getEffectiveRole, getAccessibleTrashItems, roleSatisfies, shareAccessOptions } from "../utils/permissions.js";

export async function updateDirectoriesSize(parentId, deltaSize) {
  while (parentId) {
    // $inc is applied atomically by MongoDB itself, so two concurrent calls
    // (e.g. two uploads finishing at the same time) can never overwrite
    // each other the way a find -> mutate in JS -> save() would.
    const dir = await Directory.findByIdAndUpdate(
      parentId,
      { $inc: { size: deltaSize } },
      { select: "parentDirId" }
    );
    if (!dir) break;
    parentId = dir.parentDirId;
  }
}

export const moveFile = async (req, res, next) => {
  const { id } = req.params;
  const { newParentDirId } = req.body;

  if (!newParentDirId) {
    return res.status(400).json({ error: "newParentDirId is required" });
  }

  // Need edit access to the file itself...
  const fileRole = await getEffectiveRole("file", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(fileRole, "editor")) {
    return res.status(404).json({ error: "File not found!" });
  }

  // ...and edit access to the destination folder.
  const destRole = await getEffectiveRole("directory", newParentDirId, req.user, shareAccessOptions(req));
  if (!roleSatisfies(destRole, "editor")) {
    return res.status(404).json({ error: "Destination folder not found!" });
  }

  try {
    const file = await File.findOne({ _id: id, deleted: false });
    if (!file) {
      return res.status(404).json({ error: "File not found!" });
    }

    const destination = await Directory.findOne({ _id: newParentDirId, deleted: false });
    if (!destination) {
      return res.status(404).json({ error: "Destination folder not found!" });
    }

    if (file.parentDirId.toString() === newParentDirId.toString()) {
      return res.status(200).json({ message: "File is already in that folder" });
    }

    const oldParentDirId = file.parentDirId;
    file.parentDirId = newParentDirId;
    await file.save();

    // Move the file's size off the old folder chain and onto the new one.
    await updateDirectoriesSize(oldParentDirId, -file.size);
    await updateDirectoriesSize(newParentDirId, file.size);

    return res.status(200).json({ message: "File moved" });
  } catch (err) {
    next(err);
  }
};

export const getFile = async (req, res) => {
  const { id } = req.params;

  // Owner OR a user this file/its parent folder has been shared with (viewer+).
  const role = await getEffectiveRole("file", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "viewer")) {
    return res.status(404).json({ error: "File not found!" });
  }

  const fileData = await File.findOne({ _id: id, deleted: false }).lean();
  if (!fileData) {
    return res.status(404).json({ error: "File not found!" });
  }

  if (req.query.action === "download") {
    const fileUrl = await createGetSignedUrl({
      key: `${id}${fileData.extension}`,
      download: true,
      filename: fileData.name,
    });
    return res.redirect(fileUrl);
  }

  // Send file
  const fileUrl = await createGetSignedUrl({
    key: `${id}${fileData.extension}`,
    filename: fileData.name,
  });

  return res.redirect(fileUrl);
};

export const renameFile = async (req, res, next) => {
  const { id } = req.params;

  // Owner OR editor (via share) can rename; viewers cannot.
  const role = await getEffectiveRole("file", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "File not found!" });
  }

  const file = await File.findOne({ _id: id, deleted: false });
  if (!file) {
    return res.status(404).json({ error: "File not found!" });
  }

  try {
    file.name = req.body.newFilename;
    await file.save();
    return res.status(200).json({ message: "Renamed" });
  } catch (err) {
    console.log(err);
    err.status = 500;
    next(err);
  }
};

export const deleteFile = async (req, res, next) => {
  const { id } = req.params;

  // Owner OR editor (via share) can delete; viewers cannot.
  const role = await getEffectiveRole("file", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "File not found!" });
  }

  const file = await File.findOne({
    _id: id,
    deleted: false,
  });

  if (!file) {
    return res.status(404).json({ error: "File not found!" });
  }

  try {
    file.deleted = true;
    file.deletedAt = new Date();
    await file.save();
    return res.status(200).json({ message: "File moved to trash" });
  } catch (err) {
    next(err);
  }
};

export const restoreFile = async (req, res, next) => {
  const { id } = req.params;

  // Owner OR editor (via share) can restore; viewers cannot.
  const role = await getEffectiveRole("file", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "File not found in trash!" });
  }

  const file = await File.findOne({
    _id: id,
    deleted: true,
  });

  if (!file) {
    return res.status(404).json({ error: "File not found in trash!" });
  }

  try {
    file.deleted = false;
    file.deletedAt = null;
    await file.save();
    return res.status(200).json({ message: "File restored" });
  } catch (err) {
    next(err);
  }
};

export const permanentlyDeleteFile = async (req, res, next) => {
  const { id } = req.params;

  // Owner OR editor (via share) can permanently delete; viewers cannot.
  const role = await getEffectiveRole("file", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "File not found in trash!" });
  }

  const file = await File.findOne({
    _id: id,
    deleted: true,
  });

  if (!file) {
    return res.status(404).json({ error: "File not found in trash!" });
  }

  try {
    await file.deleteOne();
    await updateDirectoriesSize(file.parentDirId, -file.size);
    await deleteObject(`${id}${file.extension}`);
    return res.status(200).json({ message: "File permanently deleted" });
  } catch (err) {
    next(err);
  }
};

export const getTrash = async (req, res, next) => {
  try {
    const { files, directories } = await getAccessibleTrashItems(req.user);

    return res.json({
      files: files.map((file) => ({ ...file, id: file._id.toString() })),
      directories: directories.map((dir) => ({ ...dir, id: dir._id.toString() })),
    });
  } catch (err) {
    next(err);
  }
};

export const uploadInitiate = async (req, res, next) => {
  const parentDirId = req.body.parentDirId || req.user.rootDirId;
  try {
    const role = await getEffectiveRole("directory", parentDirId, req.user, shareAccessOptions(req));
    if (!roleSatisfies(role, "editor")) {
      return res.status(404).json({ error: "Parent directory not found!" });
    }

    const parentDirData = await Directory.findOne({
      _id: parentDirId,
      deleted: false,
    });

    if (!parentDirData) {
      return res.status(404).json({ error: "Parent directory not found!" });
    }

    const filename = req.body.name || "untitled";
    const filesize = req.body.size;

    // Quota is enforced against the drive owner, not the uploader.
    const owner = await User.findById(parentDirData.userId);
    const ownerRootDir = await Directory.findById(owner.rootDirId);

    const remainingSpace = owner.maxStorageInBytes - ownerRootDir.size;

    if (filesize > remainingSpace) {
      return res.status(507).json({ error: "Not enough storage." });
    }

    const extension = path.extname(filename);
    const insertedFile = await File.insertOne({
      extension,
      name: filename,
      size: filesize,
      parentDirId: parentDirData._id,
      userId: parentDirData.userId,
      isUploading: true,
    });
    const uploadSignedUrl = await createUploadSignedUrl({
      key: `${insertedFile.id}${extension}`,
      contentType: req.body.contentType,
    });
    res.json({ uploadSignedUrl, fileId: insertedFile.id });
  } catch (err) {
    next(err);
  }
};

export const uploadComplete = async (req, res, next) => {
  try {
    const { fileId } = req.body;

    const file = await File.findOne({ _id: fileId });

    if (!file) {
      return res.status(404).json({
        error: "File not found",
      });
    }

    const role = await getEffectiveRole("directory", file.parentDirId, req.user, shareAccessOptions(req));
    if (!roleSatisfies(role, "editor")) {
      return res.status(404).json({ error: "File not found" });
    }

    if (!file.isUploading) {
      return res.json({
        success: true,
      });
    }

    const metadata = await getObjectMetadata(
      `${file._id}${file.extension}`
    );

    if (!metadata.ContentLength) {
      return res.status(400).json({
        error: "Upload not found on S3",
      });
    }

    if (metadata.ContentLength !== file.size) {
      return res.status(400).json({
        error: "Uploaded file is corrupted.",
      });
    }

    file.isUploading = false;
    await file.save();

    await updateDirectoriesSize(file.parentDirId, file.size);

    return res.json({
      success: true,
    });

  } catch (err) {
    next(err);
  }
};