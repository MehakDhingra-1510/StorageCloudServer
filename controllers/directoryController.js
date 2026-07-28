import Directory from "../models/directoryModel.js";
import File from "../models/fileModel.js";
import { updateDirectoriesSize } from "./fileController.js";
import { deleteObject } from "../config/s3.js";
import { getEffectiveRole, getAccessibleTrashItems, roleSatisfies, shareAccessOptions } from "../utils/permissions.js";

export const getDirectory = async (req, res) => {
  const user = req.user;
  const _id = req.params.id || user.rootDirId.toString();

  const access = shareAccessOptions(req);
  const role = await getEffectiveRole("directory", _id, user, access);
  if (!roleSatisfies(role, "viewer")) {
    return res
      .status(404)
      .json({ error: "Directory not found or you do not have access to it!" });
  }

  const directoryData = await Directory.findOne({ _id, deleted: false }).lean();
  if (!directoryData) {
    return res
      .status(404)
      .json({ error: "Directory not found or you do not have access to it!" });
  }

  const files = await File.find({
    parentDirId: directoryData._id,
    deleted: false,
    isUploading: { $ne: true },
  }).lean();
  const directories = await Directory.find({ parentDirId: _id, deleted: false }).lean();

  // Walk parentDirId up to the root, collecting each ancestor's _id/name,
  // then reverse so the array reads root -> ... -> current directory, which
  // is the shape the client's Breadcrumb component expects in data.breadCrumb.
  const breadCrumb = [{ _id: directoryData._id, name: directoryData.name }];
  let currentParentId = directoryData.parentDirId;
  while (currentParentId) {
    const ancestor = await Directory.findById(currentParentId)
      .select("name parentDirId")
      .lean();
    if (!ancestor) break;
    breadCrumb.push({ _id: ancestor._id, name: ancestor.name });
    currentParentId = ancestor.parentDirId;
  }
  breadCrumb.reverse();
  if (breadCrumb.length) breadCrumb[0].name = "My Drive";

  return res.status(200).json({
    ...directoryData,
    role,
    breadCrumb,
    files: files.map((dir) => ({ ...dir, id: dir._id })),
    directories: directories.map((dir) => ({ ...dir, id: dir._id })),
  });
};

export const createDirectory = async (req, res, next) => {
  const user = req.user;

  const parentDirId = req.params.parentDirId || user.rootDirId.toString();
  const dirname = req.headers.dirname || "New Folder";

  const access = shareAccessOptions(req);
  const role = await getEffectiveRole("directory", parentDirId, user, access);
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ message: "Parent Directory Does not exist!" });
  }

  try {
    const parentDir = await Directory.findOne({
      _id: parentDirId,
    }).lean();

    if (!parentDir)
      return res
        .status(404)
        .json({ message: "Parent Directory Does not exist!" });

    await Directory.insertOne({
      name: dirname,
      parentDirId,
      userId: parentDir.userId,
    });

    return res.status(201).json({ message: "Directory Created!" });
  } catch (err) {
    if (err.code === 121) {
      res
        .status(400)
        .json({ error: "Invalid input, please enter valid details" });
    } else {
      next(err);
    }
  }
};

export const renameDirectory = async (req, res, next) => {
  const { id } = req.params;
  const { newDirName } = req.body;

  const role = await getEffectiveRole("directory", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "Directory not found!" });
  }

  try {
    await Directory.findOneAndUpdate(
      { _id: id, deleted: false },
      { name: newDirName }
    );
    res.status(200).json({ message: "Directory Renamed!" });
  } catch (err) {
    next(err);
  }
};

export const deleteDirectory = async (req, res, next) => {
  const { id } = req.params;

  // Owner OR editor (via share) can delete; viewers cannot.
  const role = await getEffectiveRole("directory", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "Directory not found!" });
  }

  try {
    const directoryData = await Directory.findOne({
      _id: id,
      deleted: false,
    }).lean();

    if (!directoryData) {
      return res.status(404).json({ error: "Directory not found!" });
    }

    async function getDirectoryContents(id) {
      let files = await File.find({ parentDirId: id, deleted: false })
        .select("_id")
        .lean();
      let directories = await Directory.find({ parentDirId: id, deleted: false })
        .select("_id")
        .lean();

      for (const { _id } of directories) {
        const { files: childFiles, directories: childDirectories } =
          await getDirectoryContents(_id);

        files = [...files, ...childFiles];
        directories = [...directories, ...childDirectories];
      }

      return { files, directories };
    }

    const { files, directories } = await getDirectoryContents(id);
    const now = new Date();

    // Soft-delete the directory itself plus every descendant file/folder,
    // so the whole subtree can be recovered together from trash.
    await File.updateMany(
      { _id: { $in: files.map(({ _id }) => _id) } },
      { deleted: true, deletedAt: now }
    );

    await Directory.updateMany(
      { _id: { $in: [...directories.map(({ _id }) => _id), id] } },
      { deleted: true, deletedAt: now }
    );

    // Note: size is intentionally left counted against the user's quota
    // while the directory sits in trash (matches Drive-style behaviour) —
    // it's only freed up on permanent deletion.
  } catch (err) {
    return next(err);
  }
  return res.json({ message: "Moved to trash" });
};

export const restoreDirectory = async (req, res, next) => {
  const { id } = req.params;

  // Owner OR editor (via share) can restore; viewers cannot.
  const role = await getEffectiveRole("directory", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "Directory not found in trash!" });
  }

  try {
    const directoryData = await Directory.findOne({
      _id: id,
      deleted: true,
    }).lean();

    if (!directoryData) {
      return res.status(404).json({ error: "Directory not found in trash!" });
    }

    async function getDirectoryContents(id) {
      let files = await File.find({ parentDirId: id, deleted: true })
        .select("_id")
        .lean();
      let directories = await Directory.find({ parentDirId: id, deleted: true })
        .select("_id")
        .lean();

      for (const { _id } of directories) {
        const { files: childFiles, directories: childDirectories } =
          await getDirectoryContents(_id);

        files = [...files, ...childFiles];
        directories = [...directories, ...childDirectories];
      }

      return { files, directories };
    }

    const { files, directories } = await getDirectoryContents(id);

    await File.updateMany(
      { _id: { $in: files.map(({ _id }) => _id) } },
      { deleted: false, deletedAt: null }
    );

    await Directory.updateMany(
      { _id: { $in: [...directories.map(({ _id }) => _id), id] } },
      { deleted: false, deletedAt: null }
    );

    return res.json({ message: "Directory restored" });
  } catch (err) {
    return next(err);
  }
};

export const permanentlyDeleteDirectory = async (req, res, next) => {
  const { id } = req.params;

  // Owner OR editor (via share) can permanently delete; viewers cannot.
  const role = await getEffectiveRole("directory", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(role, "editor")) {
    return res.status(404).json({ error: "Directory not found in trash!" });
  }

  try {
    const directoryData = await Directory.findOne({
      _id: id,
      deleted: true,
    }).lean();

    if (!directoryData) {
      return res.status(404).json({ error: "Directory not found in trash!" });
    }

    async function getDirectoryContents(id) {
      let files = await File.find({ parentDirId: id })
        .select("extension")
        .lean();
      let directories = await Directory.find({ parentDirId: id })
        .select("_id")
        .lean();

      for (const { _id } of directories) {
        const { files: childFiles, directories: childDirectories } =
          await getDirectoryContents(_id);

        files = [...files, ...childFiles];
        directories = [...directories, ...childDirectories];
      }

      return { files, directories };
    }

    const { files, directories } = await getDirectoryContents(id);

    // Files live in S3, not on local disk — delete the actual objects there.
    await Promise.all(
      files.map(({ _id, extension }) => deleteObject(`${_id.toString()}${extension}`))
    );

    await File.deleteMany({
      _id: { $in: files.map(({ _id }) => _id) },
    });

    await Directory.deleteMany({
      _id: { $in: [...directories.map(({ _id }) => _id), id] },
    });

    await updateDirectoriesSize(directoryData.parentDirId, -directoryData.size);
  } catch (err) {
    return next(err);
  }
  return res.json({ message: "Directory permanently deleted" });
};

export const emptyTrash = async (req, res, next) => {
  try {
    const { files: trashedFiles, directories: trashedDirectories } =
      await getAccessibleTrashItems(req.user);

    if (trashedFiles.length === 0 && trashedDirectories.length === 0) {
      return res.json({ message: "Trash is already empty" });
    }

    const trashedDirIds = new Set(trashedDirectories.map((d) => d._id.toString()));

    const isTopLevel = (parentDirId) =>
      !parentDirId || !trashedDirIds.has(parentDirId.toString());

    const topLevelDirs = trashedDirectories.filter((d) => isTopLevel(d.parentDirId));
    const topLevelFiles = trashedFiles.filter((f) => isTopLevel(f.parentDirId));

    await Promise.all([
      ...topLevelDirs.map((d) => updateDirectoriesSize(d.parentDirId, -d.size)),
      ...topLevelFiles.map((f) => updateDirectoriesSize(f.parentDirId, -f.size)),
    ]);

    await Promise.all(
      trashedFiles.map(({ _id, extension }) => deleteObject(`${_id.toString()}${extension}`))
    );

    await File.deleteMany({ _id: { $in: trashedFiles.map((f) => f._id) } });
    await Directory.deleteMany({ _id: { $in: trashedDirectories.map((d) => d._id) } });

    return res.json({
      message: "Trash emptied",
      filesDeleted: trashedFiles.length,
      directoriesDeleted: trashedDirectories.length,
    });
  } catch (err) {
    return next(err);
  }
};

export const moveDirectory = async (req, res, next) => {
  const { id } = req.params;
  const { newParentDirId } = req.body;

  if (!newParentDirId) {
    return res.status(400).json({ error: "newParentDirId is required" });
  }

  if (newParentDirId.toString() === id.toString()) {
    return res.status(400).json({ error: "Cannot move a folder into itself" });
  }

  const dirRole = await getEffectiveRole("directory", id, req.user, shareAccessOptions(req));
  if (!roleSatisfies(dirRole, "editor")) {
    return res.status(404).json({ error: "Directory not found!" });
  }

  const destRole = await getEffectiveRole("directory", newParentDirId, req.user, shareAccessOptions(req));
  if (!roleSatisfies(destRole, "editor")) {
    return res.status(404).json({ error: "Destination folder not found!" });
  }

  try {
    const directory = await Directory.findOne({ _id: id, deleted: false });
    if (!directory) {
      return res.status(404).json({ error: "Directory not found!" });
    }

    const destination = await Directory.findOne({ _id: newParentDirId, deleted: false });
    if (!destination) {
      return res.status(404).json({ error: "Destination folder not found!" });
    }

    // Prevent creating a cycle: the destination can't be a descendant of
    // the folder being moved (moving a folder "into" one of its own
    // subfolders would make it its own ancestor).
    if (await isSameOrDescendant(newParentDirId, id)) {
      return res.status(400).json({ error: "Cannot move a folder into one of its own subfolders" });
    }

    if (directory.parentDirId?.toString() === newParentDirId.toString()) {
      return res.status(200).json({ message: "Folder is already in that location" });
    }

    const oldParentDirId = directory.parentDirId;
    directory.parentDirId = newParentDirId;
    await directory.save();

    await updateDirectoriesSize(oldParentDirId, -directory.size);
    await updateDirectoriesSize(newParentDirId, directory.size);

    return res.status(200).json({ message: "Directory moved" });
  } catch (err) {
    return next(err);
  }
};

// True if candidateId is targetId itself, or lives anywhere inside it —
// i.e. walking up candidateId's ancestor chain reaches targetId.
async function isSameOrDescendant(candidateId, targetId) {
  const targetStr = targetId.toString();
  let currentId = candidateId.toString();

  if (currentId === targetStr) return true;

  while (currentId) {
    const current = await Directory.findById(currentId).select("parentDirId").lean();
    if (!current || !current.parentDirId) return false;
    currentId = current.parentDirId.toString();
    if (currentId === targetStr) return true;
  }
  return false;
}

// Escapes regex special characters so a literal search term like "3.5 (final)"
// doesn't get interpreted as a regex pattern (or throw on invalid patterns).
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const searchDirectory = async (req, res, next) => {
  try {
    const query = req.query.q?.trim() || "";

    if (!query) {
      return res.json({ directories: [], files: [] });
    }

    const nameMatch = { $regex: escapeRegex(query), $options: "i" };

    const [ownedFiles, ownedDirectories, candidateFiles, candidateDirectories] =
      await Promise.all([
        File.find({
          userId: req.user._id,
          deleted: false,
          isUploading: { $ne: true },
          name: nameMatch,
        }).lean(),
        Directory.find({
          userId: req.user._id,
          deleted: false,
          parentDirId: { $ne: null },
          name: nameMatch,
        }).lean(),
        File.find({
          userId: { $ne: req.user._id },
          deleted: false,
          isUploading: { $ne: true },
          name: nameMatch,
        }).lean(),
        Directory.find({
          userId: { $ne: req.user._id },
          deleted: false,
          parentDirId: { $ne: null },
          name: nameMatch,
        }).lean(),
      ]);

    const files = [...ownedFiles];
    const directories = [...ownedDirectories];
    const seenFileIds = new Set(ownedFiles.map((f) => f._id.toString()));
    const seenDirIds = new Set(ownedDirectories.map((d) => d._id.toString()));

    for (const file of candidateFiles) {
      const id = file._id.toString();
      if (seenFileIds.has(id)) continue;
      const role = await getEffectiveRole("file", file._id, req.user, shareAccessOptions(req));
      if (roleSatisfies(role, "viewer")) {
        files.push(file);
        seenFileIds.add(id);
      }
    }

    for (const dir of candidateDirectories) {
      const id = dir._id.toString();
      if (seenDirIds.has(id)) continue;
      const role = await getEffectiveRole("directory", dir._id, req.user, shareAccessOptions(req));
      if (roleSatisfies(role, "viewer")) {
        directories.push(dir);
        seenDirIds.add(id);
      }
    }

    // Resolve each match's immediate parent folder name so results from
    // different parts of the drive can be told apart in the UI.
    const parentIds = [
      ...new Set(
        [...files, ...directories]
          .map((item) => item.parentDirId?.toString())
          .filter(Boolean)
      ),
    ];
    const parents = await Directory.find({ _id: { $in: parentIds } })
      .select("name parentDirId")
      .lean();
    const parentNameById = new Map(parents.map((p) => [p._id.toString(), p.name]));

    const locationFor = (parentDirId) => {
      if (!parentDirId) return "My Drive";
      return parentNameById.get(parentDirId.toString()) || "My Drive";
    };

    return res.json({
      directories: directories.map((dir) => ({
        ...dir,
        id: dir._id.toString(),
        location: locationFor(dir.parentDirId),
      })),
      files: files.map((file) => ({
        ...file,
        id: file._id.toString(),
        location: locationFor(file.parentDirId),
      })),
    });
  } catch (err) {
    next(err);
  }
};