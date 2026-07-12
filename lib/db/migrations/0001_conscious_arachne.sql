CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "DocumentChunk" (
	"blobUrl" text NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"embedding" vector(512),
	"fileName" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL REFERENCES "User"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "DocumentChunk_embedding_idx"
	ON "DocumentChunk"
	USING hnsw ("embedding" vector_cosine_ops);
