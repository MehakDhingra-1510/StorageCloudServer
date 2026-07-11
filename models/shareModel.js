import crypto from "crypto";
import { model, Schema } from "mongoose";

const shareSchema = new Schema(
  {
    resourceType: {
      type: String,
      enum: ["file", "directory"],
      required: true,
    },
    resourceId: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "resourceType", // "File" or "Directory" — capitalised in code, not stored here
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    role: {
      type: String,
      enum: ["viewer", "editor"],
      default: "viewer",
    },
    // null => public link share (anyone with the token/URL).
    // set  => shared with a specific registered user by email.
    sharedWithEmail: {
      type: String,
      default: null,
    },
    // Opaque token used for guest link access (/share/link/:token).
    // Always generated, even for email shares, so every share has a stable URL.
    token: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomBytes(16).toString("hex"),
    },
  },
  {
    strict: "throw",
    timestamps: true,
  }
);

// A resource can be shared with the same person only once — re-sharing
// updates the existing record's role instead of creating duplicates.
shareSchema.index(
  { resourceType: 1, resourceId: 1, sharedWithEmail: 1 },
  { unique: true }
);

const Share = model("Share", shareSchema);
export default Share;
