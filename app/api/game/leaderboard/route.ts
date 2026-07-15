import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getLeaderboards } from "@/lib/word-game";

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const leaderboards = await getLeaderboards();
  return NextResponse.json(leaderboards);
}
