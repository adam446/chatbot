import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { startGame } from "@/lib/word-game";

const bodySchema = z.object({
  length: z.number().int().min(4).max(10),
  maxGuesses: z.number().int().min(3).max(10),
  mode: z.enum(["free", "daily"]),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid game settings" },
      { status: 400 }
    );
  }

  try {
    const game = await startGame({
      length: parsed.data.length,
      maxGuesses: parsed.data.maxGuesses,
      mode: parsed.data.mode,
      userId: session.user.id,
    });

    return NextResponse.json({ game });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not start game",
      },
      { status: 500 }
    );
  }
}
