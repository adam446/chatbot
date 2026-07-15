import { ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import {
  allowedModelIds,
  chatModels,
  DEFAULT_CHAT_MODEL,
  getCapabilities,
  getModelAvailability,
} from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { editDocument } from "@/lib/ai/tools/edit-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit } from "@/lib/ratelimit";
import { getAutomaticSearchMode } from "@/lib/search-mode";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/tools";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import {
  convertToUIMessages,
  generateUUID,
  getTextFromMessage,
} from "@/lib/utils";
import { deepSearch, searchWeb } from "@/lib/web-search";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

const HEALTH_CHECK_DELAY_MS = 9000;
const BOTID_ENABLED = process.env.NEXT_PUBLIC_BOTID_ENABLED === "1";

function isModelStreamActivity(chunk: { type: string }) {
  return !["start", "start-step", "finish-step", "finish", "raw"].includes(
    chunk.type
  );
}

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch {
    return null;
  }
}

export { getStreamContext };

function getSearchQuery(message?: ChatMessage) {
  const text = message ? getTextFromMessage(message).trim() : "";
  return text.slice(0, 500);
}

function formatServerSearchContext(
  mode: "search" | "deep",
  search:
    | Awaited<ReturnType<typeof searchWeb>>
    | Awaited<ReturnType<typeof deepSearch>>
) {
  if (!search.configured) {
    return `\n\nServer-side ${mode} was requested but is not configured: ${search.message ?? "No search provider is configured."}`;
  }

  if (search.results.length === 0) {
    return `\n\nServer-side ${mode} was requested but returned no sources.${search.message ? ` Message: ${search.message}` : ""}`;
  }

  const sources = search.results
    .map(
      (result, index) =>
        `${index + 1}. ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`
    )
    .join("\n\n");

  return [
    `\n\nServer-side ${mode} results are already available for this turn.`,
    `Provider: ${search.provider ?? "unknown"}`,
    "Use these sources before relying on model memory. Cite the relevant URLs in the answer.",
    "Sources:",
    sources,
    "Do not say web search is unavailable when server-side results are provided above.",
  ].join("\n");
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const {
      id,
      message,
      messages,
      searchMode,
      selectedChatModel,
      selectedVisibilityType,
    } = requestBody;

    const [botIdResult, session] = await Promise.all([
      BOTID_ENABLED ? checkBotId().catch(() => null) : Promise.resolve(null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      return new ChatbotError("forbidden:api").toResponse();
    }

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const chatModel = allowedModelIds.has(selectedChatModel)
      ? selectedChatModel
      : DEFAULT_CHAT_MODEL;

    await checkIpRateLimit(ipAddress(request));

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      differenceInHours: 1,
      id: session.user.id,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        title: "New chat",
        userId: session.user.id,
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        message as ChatMessage,
      ];
    }

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId: id,
            createdAt: new Date(),
            id: message.id,
            parts: message.parts,
            role: "user",
          },
        ],
      });
    }

    const modelConfig = chatModels.find((m) => m.id === chatModel);
    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;

    const modelMessages = await convertToModelMessages(uiMessages);
    const searchQuery = getSearchQuery(message as ChatMessage | undefined);
    const automaticSearchMode = getAutomaticSearchMode(searchQuery);
    const effectiveSearchMode =
      searchMode === "off" ? automaticSearchMode : searchMode;

    console.log("[chat] request", {
      automaticSearchMode,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      effectiveSearchMode,
      hasMessage: Boolean(message),
      hasSearchQuery: Boolean(searchQuery),
      searchMode,
    });

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const modelName = modelConfig?.name ?? chatModel;
        let hasModelActivity = false;
        let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;

        const clearHealthCheckTimer = () => {
          if (healthCheckTimer) {
            clearTimeout(healthCheckTimer);
          }
        };

        const writeWaitingStatus = (
          phase: WaitingStatusData["phase"],
          messageText: string
        ) => {
          if (hasModelActivity && phase !== "thinking") {
            return;
          }
          dataStream.write({
            data: {
              message: messageText,
              modelId: chatModel,
              modelName,
              phase,
            },
            transient: true,
            type: "data-waiting-status",
          });
        };

        writeWaitingStatus("waiting", "Waiting...");

        healthCheckTimer = setTimeout(() => {
          getModelAvailability(chatModel)
            .then((availability) => {
              if (availability === "impacted") {
                writeWaitingStatus(
                  "health",
                  `${modelName} may be slow or unavailable right now...`
                );
              } else {
                writeWaitingStatus("still-waiting", "Still waiting...");
              }
            })
            .catch(() => {
              writeWaitingStatus("still-waiting", "Still waiting...");
            });
        }, HEALTH_CHECK_DELAY_MS);

        const markModelActive = () => {
          if (hasModelActivity) {
            return;
          }
          hasModelActivity = true;
          clearHealthCheckTimer();
          writeWaitingStatus("thinking", "Thinking...");
        };

        const stopWaitingStatus = () => {
          hasModelActivity = true;
          clearHealthCheckTimer();
        };

        const bearerToken =
          request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ??
          "";

        let serverSearchContext = "";

        if (searchQuery && effectiveSearchMode === "search") {
          writeWaitingStatus("waiting", "Searching...");
          const search = await searchWeb(searchQuery);
          console.log("[search] server-side search", {
            automaticSearchMode,
            configured: search.configured,
            provider: search.provider,
            requestedSearchMode: searchMode,
            results: search.results.length,
          });
          serverSearchContext = formatServerSearchContext("search", search);
        } else if (searchQuery && effectiveSearchMode === "deep") {
          writeWaitingStatus("waiting", "Deep searching...");
          const search = await deepSearch(searchQuery);
          console.log("[search] server-side deep search", {
            automaticSearchMode,
            configured: search.configured,
            provider: search.provider,
            requestedSearchMode: searchMode,
            results: search.results.length,
          });
          serverSearchContext = formatServerSearchContext("deep", search);
        }

        const searchInstructions =
          effectiveSearchMode === "search"
            ? "\n\nSearch mode is enabled for this turn. The server may have already injected source-backed search results below. If server-side results are present, answer from them and cite URLs. If no server-side results are present, call searchWeb with a focused query before answering. If search is not configured or returns no useful result, say that clearly."
            : effectiveSearchMode === "deep"
              ? "\n\nDeep search mode is enabled for this turn. The server may have already injected source-backed deep search results below. If server-side results are present, answer from them and cite URLs. If no server-side results are present, call deepSearch with the user's research question before answering. If deepSearch is not configured or returns no useful result, say that clearly."
              : "";

        const result = streamText({
          activeTools:
            isReasoningModel && !supportsTools
              ? []
              : [
                  "searchDocuments",
                  "searchWeb",
                  "deepSearch",
                  "getSkillDetails",
                  "getItems",
                  "getItemById",
                  "submitAction",
                  "getWeather",
                  "createDocument",
                  "editDocument",
                  "updateDocument",
                  "requestSuggestions",
                ],
          instructions: `${buildSystemPrompt()}${searchInstructions}${serverSearchContext}`,
          messages: modelMessages,
          model: getLanguageModel(chatModel),
          onAbort() {
            stopWaitingStatus();
          },
          onChunk({ chunk }) {
            if (isModelStreamActivity(chunk)) {
              markModelActive();
            }
          },
          onEnd() {
            stopWaitingStatus();
          },
          onError() {
            stopWaitingStatus();
          },
          providerOptions: {
            ...(modelConfig?.gatewayOrder && {
              gateway: { order: modelConfig.gatewayOrder },
            }),
            ...(modelConfig?.reasoningEffort && {
              openai: { reasoningEffort: modelConfig.reasoningEffort },
            }),
          },
          stopWhen: isStepCount(5),
          telemetry: {
            functionId: "stream-text",
            isEnabled: isProductionEnvironment,
          },
          tools: {
            ...createTools(bearerToken),
            createDocument: createDocument({
              dataStream,
              modelId: chatModel,
              session,
            }),
            editDocument: editDocument({ dataStream, session }),
            getWeather,
            requestSuggestions: requestSuggestions({
              dataStream,
              modelId: chatModel,
              session,
            }),
            updateDocument: updateDocument({
              dataStream,
              modelId: chatModel,
              session,
            }),
          },
        });

        dataStream.merge(
          toUIMessageStream({
            sendReasoning: isReasoningModel,
            stream: result.stream,
          })
        );

        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ data: title, type: "data-chat-title" });
            updateChatTitleById({ chatId: id, title });
          } catch {
            /* non-fatal */
          }
        }
      },
      generateId: generateUUID,
      onEnd: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          await Promise.all(
            finishedMessages.map(async (finishedMsg) => {
              const existingMsg = uiMessages.find(
                (m) => m.id === finishedMsg.id
              );
              if (existingMsg) {
                await updateMessage({
                  id: finishedMsg.id,
                  parts: finishedMsg.parts,
                });
                return;
              }

              await saveMessages({
                messages: [
                  {
                    attachments: [],
                    chatId: id,
                    createdAt: new Date(),
                    id: finishedMsg.id,
                    parts: finishedMsg.parts,
                    role: finishedMsg.role,
                  },
                ],
              });
            })
          );
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              attachments: [],
              chatId: id,
              createdAt: new Date(),
              id: currentMessage.id,
              parts: currentMessage.parts,
              role: currentMessage.role,
            })),
          });
        }
      },
      onError: (error) => {
        if (
          error instanceof Error &&
          error.message?.includes(
            "AI Gateway requires a valid credit card on file to service requests"
          )
        ) {
          return "AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.";
        }
        return "Oops, an error occurred!";
      },
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
    });

    return createUIMessageStreamResponse({
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ chatId: id, streamId });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch {
          /* non-critical */
        }
      },
      headers: {
        "x-chat-automatic-search-mode": automaticSearchMode,
        "x-chat-effective-search-mode": effectiveSearchMode,
        "x-chat-requested-search-mode": searchMode,
        "x-chat-search-query-present": String(Boolean(searchQuery)),
      },
      stream,
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatbotError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
