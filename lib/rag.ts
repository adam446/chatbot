import "server-only";

import { voyage } from "@ai-sdk/voyage";
import { embed, embedMany } from "ai";
import postgres from "postgres";

const client = postgres(process.env.POSTGRES_URL ?? "");

const embeddingModel = voyage.textEmbeddingModel("voyage-3-lite");

function chunkText(text: string, chunkSize = 400, overlap = 50): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(" ").trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    if (i + chunkSize >= words.length) {
      break;
    }
  }

  return chunks;
}

export async function ingestDocument({
  text,
  fileName,
  blobUrl,
  userId,
}: {
  text: string;
  fileName: string;
  blobUrl: string;
  userId: string;
}) {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return { chunks: 0 };
  }

  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: chunks,
  });

  for (let i = 0; i < chunks.length; i++) {
    const vectorStr = `[${embeddings[i].join(",")}]`;
    await client`
      INSERT INTO "DocumentChunk" ("fileName", "blobUrl", "content", "embedding", "userId")
      VALUES (${fileName}, ${blobUrl}, ${chunks[i]}, ${vectorStr}::vector, ${userId}::uuid)
    `;
  }

  return { chunks: chunks.length };
}

export type ChunkResult = {
  fileName: string;
  content: string;
  similarity: number;
};

export async function findRelevantChunks(
  query: string,
  limit = 5
): Promise<ChunkResult[]> {
  const { embedding } = await embed({ model: embeddingModel, value: query });
  const vectorStr = `[${embedding.join(",")}]`;

  const results = await client<ChunkResult[]>`
    SELECT
      "fileName",
      "content",
      (1 - ("embedding" <=> ${vectorStr}::vector))::float AS similarity
    FROM "DocumentChunk"
    WHERE "embedding" IS NOT NULL
      AND 1 - ("embedding" <=> ${vectorStr}::vector) > 0.4
    ORDER BY similarity DESC
    LIMIT ${limit}
  `;

  return results;
}
