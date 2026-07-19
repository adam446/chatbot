import { auth } from "@/app/(auth)/auth";
import { cancelDeepSearchJob, getDeepSearchJob } from "@/lib/deep-search-job";

async function owned(id: string) {
  const session = await auth();
  const job = await getDeepSearchJob(id);
  if (!session?.user) {
    return { error: 401 as const };
  }
  if (!job || job.userId !== session.user.id) {
    return { error: 404 as const };
  }
  return { job };
}

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await owned((await params).id);
  if ("error" in result) {
    return Response.json({ error: "Not found" }, { status: result.error });
  }
  return Response.json(result.job);
}

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await owned((await params).id);
  if ("error" in result) {
    return Response.json({ error: "Not found" }, { status: result.error });
  }
  const job = await cancelDeepSearchJob(result.job.id);
  return Response.json(job);
}
