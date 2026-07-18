import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";

const MAX_BYTES = 4.5 * 1024 * 1024;

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= MAX_BYTES, {
      message: "File size should be less than 4.5MB",
    })
    .refine(
      (file) => ["image/jpeg", "image/png", "image/webp"].includes(file.type),
      {
        message: "File type should be JPEG, PNG, or WebP",
      }
    ),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.issues
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const filename = (formData.get("file") as File).name;
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const pathname = `attachments/${session.user.id}/${Date.now()}-${safeName}`;

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json(
        { error: "BLOB_READ_WRITE_TOKEN is not configured" },
        { status: 500 }
      );
    }

    try {
      const data = await put(pathname, file, {
        access: "private",
        contentType: file.type,
      });
      const url = new URL(request.url);
      url.pathname = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/view`;
      url.search = new URLSearchParams({ pathname: data.pathname }).toString();

      return NextResponse.json({ ...data, url: url.toString() });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Blob upload error";
      console.error("[files/upload] Blob upload failed", message);

      return NextResponse.json(
        { error: `Upload failed: ${message}` },
        { status: 500 }
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to process request";
    console.error("[files/upload] Failed to process request", message);

    return NextResponse.json(
      { error: `Failed to process request: ${message}` },
      { status: 500 }
    );
  }
}
