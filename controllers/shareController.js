import { z } from "zod/v4";
import Share from "../models/shareModel.js";
import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import User from "../models/userModel.js";
import { createGetSignedUrl } from "../config/s3.js";

const createShareSchema = z.object({
  resourceType: z.enum(["file", "directory"]),
  resourceId: z.string(),
  role: z.enum(["viewer", "editor"]).default("viewer"),
  // Omit for a public link share; include to share with one registered user.
  sharedWithEmail: z.string().email().optional().nullable(),
});

// Creates or updates a share for a file/directory. Only the resource owner
// can share it. Sharing by email requires the recipient to already be a
// registered user (matches the "registered users only" rule from the spec);
// link shares are open to anyone who has the URL.
export const createShare = async (req, res, next) => {
  const { success, data, error } = createShareSchema.safeParse(req.body);
  if (!success) {
    return res.status(400).json({ error: z.flattenError(error).fieldErrors });
  }

  const { resourceType, resourceId, role, sharedWithEmail } = data;

  try {
    const Model = resourceType === "file" ? File : Directory;
    const resource = await Model.findOne({
      _id: resourceId,
      userId: req.user._id,
      deleted: false,
    }).lean();

    if (!resource) {
      return res.status(404).json({ error: "Resource not found or you do not own it." });
    }

    const normalizedEmail = sharedWithEmail ? sharedWithEmail.toLowerCase().trim() : null;

    if (normalizedEmail) {
      const recipient = await User.findOne({ email: normalizedEmail, deleted: false }).lean();
      if (!recipient) {
        return res.status(404).json({
          error: "No registered user found with that email.",
        });
      }
      if (recipient.email === req.user.email.toLowerCase().trim()) {
        return res.status(400).json({ error: "You cannot share a resource with yourself." });
      }
    }

    const share = await Share.findOneAndUpdate(
      { resourceType, resourceId, sharedWithEmail: normalizedEmail },
      { role, ownerId: req.user._id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    const shareUrl = `${process.env.CLIENT_URL}/share/${share.token}`;
    return res.status(201).json({ share, shareUrl });
  } catch (err) {
    next(err);
  }
};

export const listSharedByMe = async (req, res, next) => {
  try {
    const shares = await Share.find({ ownerId: req.user._id }).lean();
    const enriched = await enrichShares(shares);
    return res.json(enriched);
  } catch (err) {
    next(err);
  }
};

export const listSharedWithMe = async (req, res, next) => {
  try {
    const fullUser = await User.findById(req.user._id).select("email").lean();
    const shares = await Share.find({ sharedWithEmail: fullUser.email.toLowerCase().trim() }).lean();
    const enriched = await enrichShares(shares);
    return res.json(enriched);
  } catch (err) {
    next(err);
  }
};

export const revokeShare = async (req, res, next) => {
  try {
    const deleted = await Share.findOneAndDelete({
      _id: req.params.id,
      ownerId: req.user._id,
    });
    if (!deleted) {
      return res.status(404).json({ error: "Share not found." });
    }
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
};

export const updateShareRole = async (req, res, next) => {
  const { role } = req.body;
  if (!["viewer", "editor"].includes(role)) {
    return res.status(400).json({ error: "role must be 'viewer' or 'editor'." });
  }
  try {
    const share = await Share.findOneAndUpdate(
      { _id: req.params.id, ownerId: req.user._id },
      { role },
      { new: true }
    );
    if (!share) {
      return res.status(404).json({ error: "Share not found." });
    }
    return res.json(share);
  } catch (err) {
    next(err);
  }
};

// Public endpoint — no login required, mirrors "guest access via direct link".
export const accessSharedLink = async (req, res, next) => {
  try {
    const share = await Share.findOne({ token: req.params.token }).lean();
    if (!share) {
      return res.status(404).json({ error: "This share link is invalid or has expired." });
    }

    if (share.resourceType === "file") {
      const file = await File.findOne({ _id: share.resourceId, deleted: false }).lean();
      if (!file) return res.status(404).json({ error: "File not found." });

      const fileUrl = await createGetSignedUrl({
        key: `${file._id}${file.extension}`,
        download: req.query.action === "download",
        filename: file.name,
      });

      return res.json({
        resourceType: "file",
        name: file.name,
        role: share.role,
        shareToken: share.token,
        resourceId: file._id.toString(),
        url: fileUrl,
      });
    }

    // Directory share: list its immediate (non-deleted) children.
    const directory = await Directory.findOne({ _id: share.resourceId, deleted: false }).lean();
    if (!directory) return res.status(404).json({ error: "Directory not found." });

    const [files, directories] = await Promise.all([
      File.find({ parentDirId: directory._id, deleted: false }).lean(),
      Directory.find({ parentDirId: directory._id, deleted: false }).lean(),
    ]);

    return res.json({
      resourceType: "directory",
      name: directory.name,
      role: share.role,
      shareToken: share.token,
      resourceId: directory._id.toString(),
      files: files.map((f) => ({ ...f, id: f._id.toString() })),
      directories: directories.map((d) => ({ ...d, id: d._id.toString() })),
    });
  } catch (err) {
    next(err);
  }
};

async function enrichShares(shares) {
  const fileIds = shares.filter((s) => s.resourceType === "file").map((s) => s.resourceId);
  const dirIds = shares.filter((s) => s.resourceType === "directory").map((s) => s.resourceId);
  const ownerIds = [...new Set(shares.map((s) => s.ownerId.toString()))];

  const [files, directories, owners] = await Promise.all([
    File.find({ _id: { $in: fileIds } }).select("name").lean(),
    Directory.find({ _id: { $in: dirIds } }).select("name").lean(),
    User.find({ _id: { $in: ownerIds } }).select("name email").lean(),
  ]);

  const nameById = new Map([
    ...files.map((f) => [f._id.toString(), f.name]),
    ...directories.map((d) => [d._id.toString(), d.name]),
  ]);
  const ownerById = new Map(owners.map((o) => [o._id.toString(), o]));

  return shares.map((s) => ({
    ...s,
    resourceName: nameById.get(s.resourceId.toString()) || "(deleted)",
    ownerName: ownerById.get(s.ownerId.toString())?.name || null,
    ownerEmail: ownerById.get(s.ownerId.toString())?.email || null,
  }));
}
