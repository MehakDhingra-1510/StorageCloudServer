import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mime from "mime-types";

export const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

// Strip stray quotes so a value like '"mehak-storage"' in the env file
// resolves to the real bucket name and not a literal quoted string.
const BUCKET_NAME = process.env.AWS_BUCKET_NAME?.replace(/"/g, "");
export const createUploadSignedUrl = async ({ key, contentType }) => {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: 300,
    signableHeaders: new Set(["content-type"]),
  });

  return url;
};

export const createGetSignedUrl = async ({
  key,
  download = false,
  filename,
}) => {
  // Previously this relied entirely on whatever Content-Type was stored on
  // the S3 object at upload time (which came from the browser's File.type —
  // often blank or wrong for .txt/.csv/etc depending on OS/browser). That
  // made preview flaky: a wrong/missing content type causes the browser to
  // download the file instead of rendering it inline in an <img>/<iframe>.
  // Deriving it here from the extension is deterministic and always correct
  // for preview, independent of what got sent at upload time.
  const contentType = mime.lookup(key) || "application/octet-stream";

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ResponseContentDisposition: `${download ? "attachment" : "inline"}; filename=${encodeURIComponent(filename)}`,
    ResponseContentType: contentType,
  });

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: 300,
  });

  return url;
};
export const deleteObject = async (key) => {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    })
  );
};
export const getObjectMetadata = async (key) => {
  const command = new HeadObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  return await s3Client.send(command);
};