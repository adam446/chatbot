import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { submitGuess } from "@/lib/word-game";

const bodySchema = z.object({
  gameId: z.string().uuid(),
  guess: z.string().min(1).max(32),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid guess" }, { status: 400 });
  }

  try {
    const game = await submitGuess({
      gameId: parsed.data.gameId,
      guess: parsed.data.guess,
      userId: session.user.id,
    });

    return NextResponse.json({ game });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not submit guess",
      },
      { status: 400 }
    );
  }
}
