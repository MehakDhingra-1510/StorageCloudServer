// Optional public-link token passed by the client when browsing a shared
// folder/file through the normal authenticated file/directory APIs.
export default function attachShareToken(req, res, next) {
  const shareToken =
    req.query.shareToken?.trim() || req.headers["x-share-token"]?.trim();
  if (shareToken) req.shareToken = shareToken;
  next();
}
