import { createClient } from "redis";

let client: ReturnType<typeof createClient> | null = null;
let connecting: Promise<void> | null = null;

export function getRedisClient() {
  if (!process.env.REDIS_URL) {
    return null;
  }
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => undefined);
  }
  if (!client.isReady && !connecting) {
    connecting = client
      .connect()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        connecting = null;
      });
  }
  return client;
}
