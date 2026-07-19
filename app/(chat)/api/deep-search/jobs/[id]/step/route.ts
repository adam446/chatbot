import { auth } from "@/app/(auth)/auth";
import { getDeepSearchJob, updateDeepSearchJob } from "@/lib/deep-search-job";
import { deepSearch } from "@/lib/web-search";

export const maxDuration = 60;

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  const { id } = await params;
  const job = await getDeepSearchJob(id);
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!job || job.userId !== session.user.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (job.stage === "cancelled" || job.stage === "completed") {
    return Response.json(job);
  }

  await updateDeepSearchJob(id, { stage: "running", total: 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const result = await deepSearch(
      job.query,
      async ({ phase }) => {
        await updateDeepSearchJob(id, { error: phase, stage: "running" });
      },
      controller.signal
    );
    const completed = await updateDeepSearchJob(id, {
      completed: 1,
      result,
      stage: "completed",
    });
    return Response.json(completed);
  } catch (error) {
    const failed = await updateDeepSearchJob(id, {
      error: error instanceof Error ? error.message : "Deep Search failed",
      stage: "failed",
    });
    return Response.json(failed, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
