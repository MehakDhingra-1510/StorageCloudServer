// uploadInitiate creates a File doc with isUploading:true and a presigned PUT
// URL before the browser has actually finished uploading anything. If the
// tab is closed, the upload is cancelled, or the network drops before
// /upload/complete is called, that record sits forever: it's invisible in
// the UI (getDirectory filters isUploading:{$ne:true}) but it silently never
// gets cleaned up, and if the PUT did land, the S3 object it points at is
// orphaned too (never counted against quota, never deleted).
//
// This sweeps for isUploading:true records older than STALE_AFTER_MINUTES,
// deletes the matching S3 object if one exists, and removes the DB record.
//
// Run manually with:  node --env-file=.env scripts/cleanupStaleUploads.js
// In production, schedule this on an interval (cron job, Render Cron Job,
// GitHub Actions scheduled workflow, etc.) — e.g. every 30-60 minutes.
import { connectDB } from "../config/db.js";
import File from "../models/fileModel.js";
import { deleteObject, getObjectMetadata } from "../config/s3.js";

const STALE_AFTER_MINUTES = 60;

async function run() {
    await connectDB();

    const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000);

    const staleUploads = await File.find({
        isUploading: true,
        createdAt: { $lt: cutoff },
    }).lean();

    if (staleUploads.length === 0) {
        console.log("No stale uploads found.");
        process.exit(0);
    }

    console.log(`Found ${staleUploads.length} stale upload(s) older than ${STALE_AFTER_MINUTES} minutes.`);

    let s3ObjectsRemoved = 0;
    let dbRecordsRemoved = 0;

    for (const file of staleUploads) {
        const key = `${file._id}${file.extension}`;

        // The PUT may or may not have actually landed on S3 before the upload
        // was abandoned — check before trying to delete, so a missing object
        // doesn't get logged as an error.
        try {
            await getObjectMetadata(key);
            await deleteObject(key);
            s3ObjectsRemoved++;
        } catch (err) {
            // Object never existed (upload never got that far) — nothing to clean
            // up on the S3 side, that's expected and fine.
        }

        await File.deleteOne({ _id: file._id });
        dbRecordsRemoved++;
    }

    console.log(`Removed ${dbRecordsRemoved} stale File record(s) and ${s3ObjectsRemoved} orphaned S3 object(s).`);
    process.exit(0);
}

run().catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
});