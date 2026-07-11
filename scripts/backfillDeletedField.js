// One-time migration: backfills `deleted: false` / `deletedAt: null` onto any
// User, Directory, or File documents that predate the trash/soft-delete
// feature (Mongoose schema defaults only apply to newly-created documents,
// never retroactively to rows already in the database).
//
// Without this, any account/folder/file created before trash shipped is
// invisible to every query that filters on `deleted: false` — e.g. it can
// make your own root directory look like "Access denied".
//
// Run once with: node --env-file=.env scripts/backfillDeletedField.js
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/userModel.js";
import Directory from "../models/directoryModel.js";
import File from "../models/fileModel.js";

async function run() {
  await connectDB();

  const [users, dirs, files] = await Promise.all([
    User.updateMany({ deleted: { $exists: false } }, { $set: { deleted: false } }),
    Directory.updateMany(
      { deleted: { $exists: false } },
      { $set: { deleted: false, deletedAt: null } }
    ),
    File.updateMany(
      { deleted: { $exists: false } },
      { $set: { deleted: false, deletedAt: null } }
    ),
  ]);

  console.log(`Users backfilled:       ${users.modifiedCount}`);
  console.log(`Directories backfilled: ${dirs.modifiedCount}`);
  console.log(`Files backfilled:       ${files.modifiedCount}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
