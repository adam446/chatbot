import { auth } from "@/app/(auth)/auth";
import { createDeepSearchJob } from "@/lib/deep-search-job";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as { chatId?: string; query?: string };
  if (!body.chatId || !body.query) {
    return Response.json(
      { error: "chatId and query are required" },
      { status: 400 }
    );
  }
  const job = await createDeepSearchJob({
    chatId: body.chatId,
    query: body.query,
    userId: session.user.id,
  });
  if (!job) {
    return Response.json(
      { error: "Redis is required for long-running Deep Search" },
      { status: 503 }
    );
  }
  return Response.json(job, { status: 202 });
}
