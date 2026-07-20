import { createClient, SCHEMA_FIELD_TYPE } from "redis";

const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on("error", (err) => {
  console.log("Redis Client Error", err);
  process.exit(1);
});

await redisClient.connect();

// Every session doc is stored as session:<sessionId> = { userId, rootDirId, role, email }.
// login/logout code queries this index (@userId:{...}) to find/limit a user's active
// sessions. It must exist before any of those queries run, or they throw.
try {
  await redisClient.ft.create(
    "userIdIdx",
    {
      "$.userId": {
        type: SCHEMA_FIELD_TYPE.TAG,
        AS: "userId",
      },
    },
    {
      ON: "JSON",
      PREFIX: "session:",
    }
  );
} catch (err) {
  if (!err.message.includes("Index already exists")) {
    throw err;
  }
}

export default redisClient;
