import "server-only";

import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { ingestDocument } from "@/lib/rag";

const ALLOWED_EXTENSIONS = /\.(txt|md)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!ALLOWED_EXTENSIONS.test(file.name)) {
    return NextResponse.json(
      { error: "Only .txt and .md files are supported" },
      { status: 400 }
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 4 MB)" },
      { status: 400 }
    );
  }

  let blob: Awaited<ReturnType<typeof put>>;
  try {
    blob = await put(`documents/${session.user.id}/${file.name}`, file, {
      access: "private",
      allowOverwrite: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Blob upload failed";
    return NextResponse.json(
      { error: `Blob error: ${message}` },
      { status: 500 }
    );
  }

  const text = await file.text();
  let chunks: number;
  try {
    const result = await ingestDocument({
      blobUrl: blob.url,
      fileName: file.name,
      text,
      userId: session.user.id,
    });
    chunks = result.chunks;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingestion failed";
    return NextResponse.json(
      { error: `Embedding error: ${message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    chunks,
    fileName: file.name,
    success: true,
    url: blob.url,
  });
}
