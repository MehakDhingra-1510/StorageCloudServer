import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import Share from "../models/shareModel.js";
import User from "../models/userModel.js";

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

export function roleSatisfies(role, minRole) {
  return role && ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export function shareAccessOptions(req) {
  return req.shareToken ? { shareToken: req.shareToken } : {};
}

async function getRoleFromShareToken(shareToken, resourceType, resourceId) {
  const share = await Share.findOne({ token: shareToken }).lean();
  if (!share) return null;

  const resourceIdStr = resourceId.toString();
  const sharedResourceIdStr = share.resourceId.toString();

  if (share.resourceType === resourceType && sharedResourceIdStr === resourceIdStr) {
    return share.role;
  }

  if (share.resourceType !== "directory") return null;

  const Model = resourceType === "file" ? File : Directory;
  const resource = await Model.findById(resourceId).select("parentDirId").lean();
  if (!resource) return null;

  let parentDirId = resource.parentDirId;
  while (parentDirId) {
    if (parentDirId.toString() === sharedResourceIdStr) return share.role;
    const parentDir = await Directory.findById(parentDirId).select("parentDirId").lean();
    parentDirId = parentDir?.parentDirId ?? null;
  }

  return null;
}

async function getUserEmail(user) {
  if (user.email) return user.email.toLowerCase().trim();
  const fullUser = await User.findById(user._id).select("email").lean();
  return fullUser?.email?.toLowerCase()?.trim() ?? null;
}

function higherRole(a, b) {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

// Resolves what access `user` has to a file/directory: "owner", "editor",
// "viewer", or null (no access). Checks, in order:
//   1. Direct ownership
//   2. A share placed directly on this resource
//   3. A share placed on any ancestor directory (sharing a folder grants
//      the same role to everything nested inside it)
export async function getEffectiveRole(resourceType, resourceId, user, options = {}) {
  if (!user) return null;

  const Model = resourceType === "file" ? File : Directory;
  const resource = await Model.findOne({
    _id: resourceId,
  })
    .select("userId parentDirId")
    .lean();

  if (!resource) return null;
  if (resource.userId.toString() === user._id.toString()) return "owner";

  if (options.shareToken) {
    const tokenRole = await getRoleFromShareToken(
      options.shareToken,
      resourceType,
      resourceId
    );
    if (tokenRole) return tokenRole;
  }

  const normalizedEmail = await getUserEmail(user);
  if (!normalizedEmail) return null;

  const directShare = await Share.findOne({
    resourceType,
    resourceId,
    sharedWithEmail: normalizedEmail,
  })
    .select("role")
    .lean();

  let role = directShare ? directShare.role : null;

  // Walk up the directory tree — a share on any ancestor folder grants
  // the same access to everything nested inside it.
  let parentDirId = resource.parentDirId;
  while (parentDirId) {
    const ancestorShare = await Share.findOne({
      resourceType: "directory",
      resourceId: parentDirId,
      sharedWithEmail: normalizedEmail,
    })
      .select("role")
      .lean();

    if (ancestorShare) {
      role = higherRole(role, ancestorShare.role);
      break; // closest applicable ancestor share wins; no need to go further
    }

    const parentDir = await Directory.findById(parentDirId).select("parentDirId").lean();
    parentDirId = parentDir ? parentDir.parentDirId : null;
  }

  return role;
}

// Collects deleted files/directories nested under a directory (inclusive).
export async function collectDeletedInSubtree(dirId, files = [], directories = []) {
  const [dirFiles, dirDirs] = await Promise.all([
    File.find({ parentDirId: dirId, deleted: true }).lean(),
    Directory.find({ parentDirId: dirId, deleted: true }).lean(),
  ]);

  files.push(...dirFiles);
  directories.push(...dirDirs);

  await Promise.all(dirDirs.map((d) => collectDeletedInSubtree(d._id, files, directories)));

  return { files, directories };
}

// Returns trashed items the user owns plus trashed items in folders shared
// with them as editor (shared items belong to the drive owner, not the editor).
export async function getAccessibleTrashItems(user) {
  const [ownFiles, ownDirectories] = await Promise.all([
    File.find({ userId: user._id, deleted: true }).lean(),
    Directory.find({ userId: user._id, deleted: true }).lean(),
  ]);

  const fileById = new Map(ownFiles.map((f) => [f._id.toString(), f]));
  const dirById = new Map(ownDirectories.map((d) => [d._id.toString(), d]));

  const email = await getUserEmail(user);
  if (email) {
    const editorShares = await Share.find({
      sharedWithEmail: email,
      role: "editor",
    }).lean();

    for (const share of editorShares) {
      if (share.resourceType === "file") {
        const file = await File.findOne({ _id: share.resourceId, deleted: true }).lean();
        if (file) fileById.set(file._id.toString(), file);
      } else {
        const { files, directories } = await collectDeletedInSubtree(share.resourceId);
        files.forEach((f) => fileById.set(f._id.toString(), f));
        directories.forEach((d) => dirById.set(d._id.toString(), d));
      }
    }
  }

  return {
    files: [...fileById.values()],
    directories: [...dirById.values()],
  };
}