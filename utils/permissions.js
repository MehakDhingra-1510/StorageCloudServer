import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import Share from "../models/shareModel.js";
import User from "../models/userModel.js";

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

export function roleSatisfies(role, minRole) {
  return role && ROLE_RANK[role] >= ROLE_RANK[minRole];
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
export async function getEffectiveRole(resourceType, resourceId, user) {
  if (!user) return null;

  const Model = resourceType === "file" ? File : Directory;
  const resource = await Model.findOne({
    _id: resourceId,
    deleted: false,
  })
    .select("userId parentDirId")
    .lean();

  if (!resource) return null;
  if (resource.userId.toString() === user._id.toString()) return "owner";

  // req.user (from the Redis session) only carries _id/rootDirId, so the
  // email needed to match against Share.sharedWithEmail is fetched here.
  const fullUser = await User.findById(user._id).select("email").lean();
  if (!fullUser) return null;

  const normalizedEmail = fullUser.email.toLowerCase().trim();

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
