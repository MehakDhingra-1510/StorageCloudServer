import Directory from "../models/directoryModel.js";
import File from "../models/fileModel.js";
import { updateDirectoriesSize } from "./fileController.js";
import { deleteObject } from "../config/s3.js";
import { getEffectiveRole, roleSatisfies } from "../utils/permissions.js";

export const getDirectory = async (req, res) => {
  const user = req.user;
  const _id = req.params.id || user.rootDirId.toString();

  const role = await getEffectiveRole("directory", _id, user);
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

  const files = await File.find({ parentDirId: directoryData._id, deleted: false }).lean();
  const directories = await Directory.find({ parentDirId: _id, deleted: false }).lean();
  return res.status(200).json({
    ...directoryData,
    role,
    files: files.map((dir) => ({ ...dir, id: dir._id })),
    directories: directories.map((dir) => ({ ...dir, id: dir._id })),
  });
};

export const createDirectory = async (req, res, next) => {
  const user = req.user;

  const parentDirId = req.params.parentDirId || user.rootDirId.toString();
  const dirname = req.headers.dirname || "New Folder";

  const role = await getEffectiveRole("directory", parentDirId, user);
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
      userId: user._id,
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

  const role = await getEffectiveRole("directory", id, req.user);
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

  try {
    const directoryData = await Directory.findOne({
      _id: id,
      userId: req.user._id,
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
  try {
    const directoryData = await Directory.findOne({
      _id: id,
      userId: req.user._id,
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

  try {
    const directoryData = await Directory.findOne({
      _id: id,
      userId: req.user._id,
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

    // No parentDirId filter on either query — this intentionally searches
    // every file/folder the user owns, at any depth, not just the folder
    // currently open in the UI.
    const [files, directories] = await Promise.all([
      File.find({ userId: req.user._id, deleted: false, name: nameMatch }).lean(),
      Directory.find({
        userId: req.user._id,
        deleted: false,
        parentDirId: { $ne: null }, // exclude the user's own root directory from results
        name: nameMatch,
      }).lean(),
    ]);

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