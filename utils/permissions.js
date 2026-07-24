import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import Share from "../models/shareModel.js";
import User from "../models/userModel.js";
import { getAncestorChain } from "./directoryTree.js";

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
  //
  // Previously this was one Directory.findById() + one Share.findOne() PER
  // ancestor level, in a while loop — an N+1 query pattern run on nearly
  // every file/directory request. getAncestorChain() now fetches the whole
  // chain in a single aggregation query, and we batch-fetch shares for all
  // of those ancestors in one more query, so this is now 2 queries total
  // regardless of nesting depth instead of up to 2*depth.
  const ancestors = await getAncestorChain(resource.parentDirId);
  if (ancestors.length) {
    const ancestorShares = await Share.find({
      resourceType: "directory",
      resourceId: { $in: ancestors.map((a) => a._id) },
      sharedWithEmail: normalizedEmail,
    })
      .select("resourceId role")
      .lean();

    const shareByAncestorId = new Map(
      ancestorShares.map((s) => [s.resourceId.toString(), s.role])
    );

    // ancestors[] is ordered closest-first (immediate parent, then
    // grandparent, ...), so the first match found here is the closest
    // applicable ancestor share — same "closest wins" semantics as before.
    for (const ancestor of ancestors) {
      const ancestorRole = shareByAncestorId.get(ancestor._id.toString());
      if (ancestorRole) {
        role = higherRole(role, ancestorRole);
        break;
      }
    }
  }

  return role;
}