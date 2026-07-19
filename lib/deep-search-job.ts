import { getRedisClient } from "@/lib/redis";
import { generateUUID } from "@/lib/utils";

const TTL_SECONDS = 30 * 60;
const PREFIX = "deep-search-job:";

export type DeepSearchJob = {
  id: string;
  chatId: string;
  userId: string;
  query: string;
  stage: "queued" | "running" | "completed" | "failed" | "cancelled";
  completed: number;
  total: number;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function key(id: string) {
  return `${PREFIX}${id}`;
}

export async function createDeepSearchJob(input: {
  chatId: string;
  query: string;
  userId: string;
}) {
  const redis = getRedisClient();
  if (!redis?.isReady) {
    return null;
  }
  const now = new Date().toISOString();
  const job: DeepSearchJob = {
    chatId: input.chatId,
    completed: 0,
    createdAt: now,
    id: generateUUID(),
    query: input.query,
    stage: "queued",
    total: 1,
    updatedAt: now,
    userId: input.userId,
  };
  await redis.set(key(job.id), JSON.stringify(job), { EX: TTL_SECONDS });
  return job;
}

export async function getDeepSearchJob(id: string) {
  const redis = getRedisClient();
  if (!redis?.isReady) {
    return null;
  }
  const value = await redis.get(key(id));
  return value ? (JSON.parse(value) as DeepSearchJob) : null;
}

export async function updateDeepSearchJob(
  id: string,
  patch: Partial<DeepSearchJob>
) {
  const job = await getDeepSearchJob(id);
  if (!job) {
    return null;
  }
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  const redis = getRedisClient();
  if (!redis?.isReady) {
    return null;
  }
  await redis.set(key(id), JSON.stringify(next), { EX: TTL_SECONDS });
  return next;
}

export function cancelDeepSearchJob(id: string) {
  return updateDeepSearchJob(id, { stage: "cancelled" });
}
