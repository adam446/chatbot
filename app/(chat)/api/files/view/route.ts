import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const pathname = searchParams.get("pathname");

  if (!pathname) {
    return NextResponse.json({ error: "Missing pathname" }, { status: 400 });
  }

  if (!pathname.startsWith(`attachments/${session.user.id}/`)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await get(pathname, { access: "private" });
  if (result?.statusCode !== 200) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(result.stream, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": result.blob.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
