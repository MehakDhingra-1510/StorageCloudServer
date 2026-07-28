import redisClient from "../config/redis.js";

export async function invalidateUserSessions(userId) {
  const allSessions = await redisClient.ft.search(
    "userIdIdx",
    `@userId:{${userId}}`,
    { RETURN: [] }
  );

  if (allSessions.total > 0) {
    await redisClient.del(allSessions.documents.map(({ id }) => id));
  }
}
