import { auth } from "@/app/(auth)/auth";
import { getChatById, getMessagesByChatId } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { convertToUIMessages } from "@/lib/utils";

function shortId(value?: string | null) {
  return value ? `${value.slice(0, 8)}...${value.slice(-4)}` : null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return Response.json({ error: "chatId required" }, { status: 400 });
  }

  const [session, chat] = await Promise.all([
    auth(),
    getChatById({ id: chatId }),
  ]);

  if (!chat) {
    return Response.json({
      isReadonly: false,
      messages: [],
      userId: null,
      visibility: "private",
    });
  }

  if (
    chat.visibility === "private" &&
    (!session?.user || session.user.id !== chat.userId)
  ) {
    console.warn("[messages] forbidden private chat access", {
      chatId: shortId(chatId),
      chatUserId: shortId(chat.userId),
      sessionUserId: shortId(session?.user?.id),
      visibility: chat.visibility,
    });

    return new ChatbotError("forbidden:chat").toResponse();
  }

  const isReadonly = !session?.user || session.user.id !== chat.userId;
  const messages = await getMessagesByChatId({ id: chatId });

  return Response.json({
    isReadonly,
    messages: convertToUIMessages(messages),
    userId: chat.userId,
    visibility: chat.visibility,
  });
}
