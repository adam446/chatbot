import { get } from "@vercel/blob";
import { ipAddress } from "@vercel/functions";
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  hasToolCall,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessageStreamWriter,
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
import { getAutomaticSearchMode, isChronologyQuery } from "@/lib/search-mode";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/tools";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import {
  convertToUIMessages,
  generateUUID,
  getTextFromMessage,
} from "@/lib/utils";
import {
  buildVerifiedSearchAnswer,
  deepSearch,
  searchWeb,
} from "@/lib/web-search";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

const HEALTH_CHECK_DELAY_MS = 9000;
const BOTID_ENABLED = process.env.NEXT_PUBLIC_BOTID_ENABLED === "1";
const MODEL_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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

type ChatMessagePart = ChatMessage["parts"][number];

function getPrivateBlobPathname(url: string) {
  try {
    const parsedUrl = new URL(url, "http://localhost");
    if (!parsedUrl.pathname.endsWith("/api/files/view")) {
      return null;
    }

    return parsedUrl.searchParams.get("pathname");
  } catch {
    return null;
  }
}

function isFilePart(part: ChatMessagePart): part is ChatMessagePart & {
  mediaType: string;
  type: "file";
  url: string;
} {
  return (
    part.type === "file" &&
    "url" in part &&
    typeof part.url === "string" &&
    "mediaType" in part &&
    typeof part.mediaType === "string"
  );
}

async function hydratePrivateAttachmentPart({
  part,
  userId,
}: {
  part: ChatMessagePart;
  userId: string;
}): Promise<ChatMessagePart> {
  if (!isFilePart(part) || !part.mediaType.startsWith("image/")) {
    return part;
  }

  const pathname = getPrivateBlobPathname(part.url);
  if (!pathname) {
    return part;
  }

  if (!pathname.startsWith(`attachments/${userId}/`)) {
    throw new Error("Uploaded image does not belong to the current user");
  }

  const result = await get(pathname, { access: "private", useCache: false });
  if (result?.statusCode !== 200) {
    throw new Error(
      `Uploaded image is not readable from Blob storage (${result?.statusCode ?? "unknown"})`
    );
  }

  const contentType = result.blob.contentType || part.mediaType;
  if (!MODEL_IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error(
      `Uploaded image content type is unsupported: ${contentType}`
    );
  }

  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("Uploaded image is empty after reading from Blob storage");
  }

  console.info("[chat] hydrated private image attachment", {
    bytes: buffer.length,
    contentType,
    pathname,
  });

  return {
    ...part,
    mediaType: contentType,
    url: `data:${contentType};base64,${buffer.toString("base64")}`,
  };
}

function hydratePrivateAttachmentsForModel({
  messages,
  userId,
}: {
  messages: ChatMessage[];
  userId: string;
}) {
  return Promise.all(
    messages.map(async (msg) => ({
      ...msg,
      parts: await Promise.all(
        msg.parts.map((part) => hydratePrivateAttachmentPart({ part, userId }))
      ),
    }))
  );
}

type ImageRequestSpec = {
  normalizedText: string;
  referenceImageUrl?: string;
  toolPrompt: string;
};

type ResolvedImageContext = {
  artifactId?: string;
  promptPrefix: string;
  source:
    | "current-upload"
    | "none"
    | "previous-artifact"
    | "previous-upload"
    | "reference-url";
  urls: string[];
};

function getOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractFirstJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizeImageRequestSpec(text: string): ImageRequestSpec | null {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record) {
    return null;
  }

  // Some clients serialize image tool calls with `content` instead of `prompt`.
  // Normalize both shapes before deciding whether to force the image artifact.
  const prompt = getOptionalString(
    record.prompt ?? record.description ?? record.content
  );
  const style = getOptionalString(record.style);
  const negativePrompt = getOptionalString(
    record.negativePrompt ?? record.negative_prompt
  );
  const sourceImageUrl = getOptionalString(record.sourceImageUrl);
  const referenceImageUrl = getOptionalString(record.referenceImageUrl);
  const kind = getOptionalString(record.kind);
  const prefix = text.slice(0, text.indexOf(jsonText));
  const imageIntentText = `${prefix} ${kind ?? ""} ${prompt ?? ""} ${
    style ?? ""
  }`.toLowerCase();

  const hasImageIntent =
    /\b(image|photo|picture|mug\s*shot|portrait|avatar|poster|illustration|dessin|visuel|photorealistic|photorealiste)\b/.test(
      imageIntentText
    ) ||
    /generateimage|imagewithreference|createimage|editimage/.test(
      imageIntentText.replace(/\s+/g, "")
    );

  if (!prompt || !hasImageIntent) {
    return null;
  }

  const promptParts = [`Image request: ${prompt}`];
  if (style) {
    promptParts.push(`Style: ${style}`);
  }
  if (negativePrompt) {
    promptParts.push(`Avoid: ${negativePrompt}`);
  }
  if (sourceImageUrl ?? referenceImageUrl) {
    promptParts.push(
      `Reference image URL: ${sourceImageUrl ?? referenceImageUrl}`
    );
  }

  return {
    normalizedText: promptParts.join("\n"),
    referenceImageUrl: sourceImageUrl ?? referenceImageUrl,
    toolPrompt: promptParts.join("\n"),
  };
}

function replaceLatestUserTextMessage({
  messages,
  text,
}: {
  messages: ChatMessage[];
  text: string;
}) {
  const latestIndex = messages.length - 1;

  return messages.map((msg, index) => {
    if (index !== latestIndex || msg.role !== "user") {
      return msg;
    }

    let replacedText = false;
    const parts = msg.parts.map((part) => {
      if (part.type !== "text" || replacedText) {
        return part;
      }
      replacedText = true;
      return { ...part, text };
    });

    return {
      ...msg,
      parts: replacedText ? parts : [{ text, type: "text" as const }, ...parts],
    };
  });
}

function isImageCreationOrEditRequest(text: string) {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(create|generate|regenerate|make|draw|edit|modify|replace|change|transform|restyle|swap|add|remove|cree|creer|genere|generer|regenere|regenerer|modifie|modifier|remplace|remplacer|change|transforme|ajoute|ajouter|enleve|enlever|fais|fait)\b/.test(
    normalized
  );
}

function isExplicitImageArtifactRequest(text: string) {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (
    isImageCreationOrEditRequest(text) &&
    /\b(image|picture|photo|illustration|drawing|dessin|visuel|visual|poster|affiche|logo|avatar|mug\s*shot|portrait)\b/.test(
      normalized
    )
  );
}

function asksForNewImageArtifact(text: string) {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(new|another|separate|fresh|different|nouveau|nouvelle|autre|separe|separee|different|differente)\b/.test(
    normalized
  );
}

function isNonImageArtifactRequest(text: string) {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(document|essay|article|rapport|report|script|code|program|spreadsheet|tableur|sheet|fichier|file|redige|rediger|ecris|ecrire|write)\b/.test(
    normalized
  );
}

function getImageAttachmentUrlsFromMessage(message: ChatMessage) {
  return message.parts
    .filter(
      (
        part
      ): part is typeof part & {
        mediaType: string;
        type: "file";
        url: string;
      } =>
        part.type === "file" &&
        "mediaType" in part &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/") &&
        "url" in part &&
        typeof part.url === "string"
    )
    .map((part) => part.url);
}

function getLatestPreviousImageAttachmentUrls(messages: ChatMessage[]) {
  const previousMessages = messages.slice(0, -1);

  for (const msg of [...previousMessages].reverse()) {
    if (msg.role !== "user") {
      continue;
    }

    const urls = getImageAttachmentUrlsFromMessage(msg);
    if (urls.length > 0) {
      return urls;
    }
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getToolOutput(part: Record<string, unknown>) {
  for (const key of ["output", "result"] as const) {
    const output = asRecord(part[key]);
    if (output) {
      return output;
    }
  }

  if (part.kind === "image") {
    return part;
  }

  return null;
}

function getLatestImageDocumentReference(messages: ChatMessage[]) {
  for (const msg of [...messages].reverse()) {
    for (const rawPart of [...msg.parts].reverse()) {
      const part = asRecord(rawPart);
      if (!part) {
        continue;
      }

      const type = typeof part.type === "string" ? part.type : "";
      if (
        !type.includes("createDocument") &&
        !type.includes("updateDocument")
      ) {
        continue;
      }

      const output = getToolOutput(part);
      if (
        output?.kind !== "image" ||
        typeof output.id !== "string" ||
        typeof output.title !== "string" ||
        "error" in output
      ) {
        continue;
      }

      return {
        id: output.id,
        title: output.title,
      };
    }
  }

  return null;
}

function resolveImageContext({
  currentImageAttachmentUrls,
  latestImageDocument,
  normalizedImageRequest,
  searchQuery,
  uiMessages,
}: {
  currentImageAttachmentUrls: string[];
  latestImageDocument: ReturnType<typeof getLatestImageDocumentReference>;
  normalizedImageRequest: ImageRequestSpec | null;
  searchQuery: string;
  uiMessages: ChatMessage[];
}): ResolvedImageContext {
  if (currentImageAttachmentUrls.length > 0) {
    return {
      promptPrefix:
        "Use the image uploaded in the current user message as the visual source. Fit the output to that uploaded image's subject, framing, composition, aspect ratio, and visual style unless the user explicitly asks to change them.",
      source: "current-upload",
      urls: currentImageAttachmentUrls,
    };
  }

  if (normalizedImageRequest?.referenceImageUrl) {
    return {
      promptPrefix:
        "Use the provided reference image URL as the visual source. Fit the output to the reference image's subject, framing, composition, aspect ratio, and visual style unless the user explicitly asks to change them.",
      source: "reference-url",
      urls: [normalizedImageRequest.referenceImageUrl],
    };
  }

  if (
    latestImageDocument &&
    (isImageCreationOrEditRequest(searchQuery) ||
      isExplicitImageArtifactRequest(`generate image ${searchQuery}`)) &&
    !asksForNewImageArtifact(searchQuery)
  ) {
    return {
      artifactId: latestImageDocument.id,
      promptPrefix:
        "Use the existing image artifact as the visual source. Preserve its subject, framing, composition, aspect ratio, and style unless the user explicitly asks to change them.",
      source: "previous-artifact",
      urls: [],
    };
  }

  const previousUploadUrls = getLatestPreviousImageAttachmentUrls(uiMessages);
  if (
    previousUploadUrls.length > 0 &&
    (isImageCreationOrEditRequest(searchQuery) ||
      isExplicitImageArtifactRequest(`generate image ${searchQuery}`))
  ) {
    return {
      promptPrefix:
        "Use the most recent previous uploaded image in this chat as the visual reference. Fit the output to that uploaded image's subject, framing, composition, aspect ratio, and visual style unless the user explicitly asks to change them.",
      source: "previous-upload",
      urls: previousUploadUrls,
    };
  }

  return {
    promptPrefix:
      "No source image is available. Generate from the text prompt only.",
    source: "none",
    urls: [],
  };
}

function stripImageAttachmentsForToolPlanning(messages: ChatMessage[]) {
  return messages.map((msg, index) => {
    if (msg.role !== "user") {
      return msg;
    }

    const imageParts = msg.parts.filter(
      (part) =>
        part.type === "file" &&
        "mediaType" in part &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/")
    );

    if (imageParts.length === 0) {
      return msg;
    }

    const nonImageParts = msg.parts.filter(
      (part) => !imageParts.includes(part)
    );
    const isLatestMessage = index === messages.length - 1;

    return {
      ...msg,
      parts: [
        ...nonImageParts,
        ...(isLatestMessage
          ? [
              {
                text: '\n\n[An uploaded image is attached to this turn. For image modification or image generation requests, call createDocument exactly once with kind "image". The server will pass the uploaded image to the image tool automatically; do not output JSON.]',
                type: "text" as const,
              },
            ]
          : []),
      ],
    };
  });
}

function stripNonLatestImageAttachments(messages: ChatMessage[]) {
  const latestIndex = messages.length - 1;

  return messages.map((msg, index) => {
    if (msg.role !== "user" || index === latestIndex) {
      return msg;
    }

    const filteredParts = msg.parts.filter(
      (part) =>
        !(
          part.type === "file" &&
          "mediaType" in part &&
          typeof part.mediaType === "string" &&
          part.mediaType.startsWith("image/")
        )
    );

    return filteredParts.length === msg.parts.length
      ? msg
      : { ...msg, parts: filteredParts };
  });
}

function formatServerSearchContext(
  mode: "search" | "deep",
  query: string,
  search:
    | Awaited<ReturnType<typeof searchWeb>>
    | Awaited<ReturnType<typeof deepSearch>>,
  verifiedAnswer: { fallbackText: string; promptHint: string } | null
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

  const report =
    "report" in search && search.report
      ? [
          "Server-side research report:",
          `Conclusion: ${search.report.conclusion}`,
          `Key findings: ${search.report.keyFindings.join(" | ") || "None"}`,
          `Disagreements: ${search.report.disagreements.join(" | ") || "None identified"}`,
          `Limitations: ${search.report.limitations.join(" | ") || "None stated"}`,
          `Citations: ${search.report.citations.join(" | ") || "None"}`,
        ].join("\n")
      : null;

  const chronologyInstructions = isChronologyQuery(query)
    ? [
        "The user requested a chronology or dated key elements.",
        "Answer in the user's language using this exact structure:",
        "1. A two-sentence overview of the dispute and its scope.",
        "2. A chronological list grouped by period, with each bullet beginning with a bold date or date range.",
        "3. For each event, state the actor, action, immediate consequence, and cite the supporting URL.",
        "4. A short Key themes section and a Sources / limitations section.",
        "Do not replace the chronology with a generic description of an institution or a single source snippet.",
        "Keep the historical context, distinguish confirmed facts from interpretation, and mention disagreements when sources differ.",
      ].join("\n")
    : [
        "Answer the user's actual question directly before adding background.",
        "Use concise headings and bullets when they improve readability.",
      ].join("\n");

  return [
    `\n\nServer-side ${mode} results are already available for this turn.`,
    `Provider: ${search.provider ?? "unknown"}`,
    verifiedAnswer
      ? `Verified answer hint:\n${verifiedAnswer.promptHint}`
      : "No deterministic verified answer was extracted; synthesize from the ranked sources below.",
    report ??
      "No server-side research report was generated; synthesize from the evidence below.",
    "Use these ranked sources before relying on model memory. The first source is the highest-priority source after server-side ranking.",
    "If sources conflict, prefer official government or primary-source domains over Wikipedia, social media, or older secondary summaries.",
    "Do not assume the first raw web result is correct unless it is also the highest-priority ranked source below.",
    "Cite the relevant URLs in the answer.",
    chronologyInstructions,
    "Sources:",
    sources,
    "Do not say web search is unavailable when server-side results are provided above.",
  ].join("\n");
}

function writeAssistantTextFallback({
  dataStream,
  text,
}: {
  dataStream: UIMessageStreamWriter<ChatMessage>;
  text: string;
}) {
  const textId = generateId();
  dataStream.write({ id: textId, type: "text-start" });
  dataStream.write({ delta: text, id: textId, type: "text-delta" });
  dataStream.write({ id: textId, type: "text-end" });
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (error) {
    console.error("[chat] bad request", error);
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

    const currentImageAttachmentUrls =
      message?.role === "user"
        ? getImageAttachmentUrlsFromMessage(message as ChatMessage)
        : [];
    const hasCurrentImageAttachment = currentImageAttachmentUrls.length > 0;
    const rawMessageText =
      message?.role === "user"
        ? getTextFromMessage(message as ChatMessage).trim()
        : "";
    const rawSearchQuery = rawMessageText.slice(0, 500);
    const normalizedImageRequest = normalizeImageRequestSpec(rawMessageText);
    const searchQuery =
      normalizedImageRequest?.normalizedText ?? rawSearchQuery;
    const shouldUseImageToolPlanning =
      hasCurrentImageAttachment &&
      (isImageCreationOrEditRequest(searchQuery) ||
        isExplicitImageArtifactRequest(`generate image ${searchQuery}`) ||
        Boolean(normalizedImageRequest));
    const latestImageDocument = getLatestImageDocumentReference(uiMessages);
    const imageContext = resolveImageContext({
      currentImageAttachmentUrls,
      latestImageDocument,
      normalizedImageRequest,
      searchQuery,
      uiMessages,
    });
    const shouldUpdateExistingImageArtifact =
      !shouldUseImageToolPlanning &&
      !hasCurrentImageAttachment &&
      Boolean(latestImageDocument) &&
      imageContext.source === "previous-artifact" &&
      !asksForNewImageArtifact(searchQuery);
    const shouldCreateImageArtifact =
      !shouldUseImageToolPlanning &&
      !shouldUpdateExistingImageArtifact &&
      !hasCurrentImageAttachment &&
      (Boolean(normalizedImageRequest) ||
        imageContext.source === "previous-upload" ||
        imageContext.source === "reference-url" ||
        isExplicitImageArtifactRequest(searchQuery));
    const shouldUseImageArtifactTool =
      shouldUseImageToolPlanning ||
      shouldUpdateExistingImageArtifact ||
      shouldCreateImageArtifact;
    const shouldExposeArtifactTools =
      shouldUseImageArtifactTool || isNonImageArtifactRequest(searchQuery);
    const contextualImagePrompt =
      shouldUseImageArtifactTool && imageContext.source !== "none"
        ? `${imageContext.promptPrefix}\n\nUser request:\n${
            normalizedImageRequest?.toolPrompt ?? searchQuery
          }`
        : (normalizedImageRequest?.toolPrompt ?? searchQuery);
    const uiMessagesForModel = normalizedImageRequest
      ? replaceLatestUserTextMessage({
          messages: uiMessages,
          text: contextualImagePrompt,
        })
      : uiMessages;
    const messagesForModel = shouldUseImageToolPlanning
      ? stripImageAttachmentsForToolPlanning(uiMessagesForModel)
      : stripNonLatestImageAttachments(uiMessagesForModel);
    const hydratedMessages = await hydratePrivateAttachmentsForModel({
      messages: messagesForModel,
      userId: session.user.id,
    });
    const modelMessages = await convertToModelMessages(hydratedMessages);
    const automaticSearchMode = getAutomaticSearchMode(searchQuery);
    const effectiveSearchMode = shouldUseImageArtifactTool
      ? "off"
      : searchMode === "off"
        ? automaticSearchMode
        : searchMode;
    const imageSourceUrls = imageContext.urls;

    console.log("[chat] request", {
      automaticSearchMode,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      effectiveSearchMode,
      hasCurrentImageAttachment,
      hasMessage: Boolean(message),
      hasPreviousUploadedImage: imageContext.source === "previous-upload",
      hasSearchQuery: Boolean(searchQuery),
      hasStructuredImageRequest: Boolean(normalizedImageRequest),
      imageContextSource: imageContext.source,
      latestImageDocumentId: latestImageDocument?.id ?? null,
      searchMode,
      shouldCreateImageArtifact,
      shouldUpdateExistingImageArtifact,
      shouldUseImageToolPlanning,
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
        let fallbackVerifiedAnswer: string | null = null;

        if (searchQuery && effectiveSearchMode === "search") {
          writeWaitingStatus("waiting", "Searching...");
          const search = await searchWeb(searchQuery);
          const verifiedAnswer = buildVerifiedSearchAnswer({
            query: searchQuery,
            results: search.results,
          });
          fallbackVerifiedAnswer = verifiedAnswer?.fallbackText ?? null;
          console.log("[search] server-side search", {
            automaticSearchMode,
            configured: search.configured,
            provider: search.provider,
            requestedSearchMode: searchMode,
            results: search.results.length,
            verifiedAnswer: Boolean(verifiedAnswer),
          });
          serverSearchContext = formatServerSearchContext(
            "search",
            searchQuery,
            search,
            verifiedAnswer
          );
        } else if (searchQuery && effectiveSearchMode === "deep") {
          writeWaitingStatus("waiting", "Deep searching...");
          const deepSearchPromise = deepSearch(
            searchQuery,
            ({ phase, completed, total }) => {
              const labels = {
                planning: "Planning deep search...",
                reading: "Reading sources...",
                searching: "Searching sources...",
                synthesizing: "Synthesizing findings...",
              } as const;
              const progress =
                typeof completed === "number" && typeof total === "number"
                  ? ` (${completed}/${total})`
                  : "";
              writeWaitingStatus(
                phase === "synthesizing" ? "thinking" : "waiting",
                `${labels[phase]}${progress}`
              );
            }
          );
          let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const fallbackPromise = new Promise<
              Awaited<ReturnType<typeof deepSearch>>
            >((resolve) => {
              fallbackTimer = setTimeout(async () => {
                const fallback = await searchWeb(searchQuery);
                resolve({
                  ...fallback,
                  message:
                    fallback.message ??
                    "Deep search timed out; used a direct search fallback.",
                  plannedQueries: [searchQuery],
                  report: null,
                  summary: "",
                });
              }, 150_000);
            });
            const search = await Promise.race([
              deepSearchPromise,
              fallbackPromise,
            ]);
            clearTimeout(fallbackTimer);
            fallbackTimer = undefined;
            const verifiedAnswer = buildVerifiedSearchAnswer({
              query: searchQuery,
              results: search.results,
            });
            fallbackVerifiedAnswer = verifiedAnswer?.fallbackText ?? null;
            console.log("[search] server-side deep search", {
              automaticSearchMode,
              configured: search.configured,
              provider: search.provider,
              requestedSearchMode: searchMode,
              results: search.results.length,
              verifiedAnswer: Boolean(verifiedAnswer),
            });
            serverSearchContext = formatServerSearchContext(
              "deep",
              searchQuery,
              search,
              verifiedAnswer
            );
          } finally {
            if (fallbackTimer) {
              clearTimeout(fallbackTimer);
            }
          }
        }

        const searchInstructions =
          effectiveSearchMode === "search"
            ? "\n\nSearch mode is enabled for this turn. The server may have already injected source-backed search results below. If server-side results are present, answer from them and cite URLs. If no server-side results are present, call searchWeb with a focused query before answering. If search is not configured or returns no useful result, say that clearly."
            : effectiveSearchMode === "deep"
              ? "\n\nDeep search mode is enabled for this turn. The server may have already injected source-backed deep search results below. If server-side results are present, answer from them and cite URLs. If no server-side results are present, call deepSearch with the user's research question before answering. If deepSearch is not configured or returns no useful result, say that clearly."
              : "";
        const imageToolInstructions = shouldUseImageToolPlanning
          ? '\n\nThe current user message includes an uploaded image and asks to create or modify an image. You MUST call createDocument exactly once with kind "image". Use a short display title, and put the user\'s complete requested transformation in the prompt field. The prompt must explicitly preserve the source image subject identity, face, pose, framing, background, line art/style, and original colors unless the user asked to change them. Do not output raw JSON, do not narrate tool use, and do not answer with only a plan.'
          : shouldUpdateExistingImageArtifact && latestImageDocument
            ? `\n\nThe current user message asks to modify the existing image artifact titled "${latestImageDocument.title}". You MUST call updateDocument exactly once with id "${latestImageDocument.id}" and description equal to the user's full request plus this context: ${imageContext.promptPrefix} Do not call createDocument. The server will pass the existing artifact image as the source image; treat it as the visual reference to edit, not as text-only context. Preserve the current image subject identity, face, pose, framing, background, line art/style, and original colors unless the user explicitly asks to change them. If the requested visual change is unclear, ask one concise clarification question instead of creating a new image.`
            : shouldCreateImageArtifact
              ? `\n\nThe current user message asks to generate an image artifact. You MUST call createDocument exactly once with kind "image". Use a short display title, and put the user's complete image request in the prompt field. Image source context: ${imageContext.promptPrefix} If a source image is available, fit the generated output to that source image's subject, composition, framing, aspect ratio, and visual style unless the user explicitly asks otherwise. If server-side search results are present, use them only as context to enrich the image prompt; do not answer with search text instead of creating the image. Do not output raw JSON, do not narrate tool use, and do not answer with only a plan.`
              : "";

        let hasAssistantText = false;

        if (fallbackVerifiedAnswer && !shouldUseImageArtifactTool) {
          stopWaitingStatus();
          writeAssistantTextFallback({
            dataStream,
            text: fallbackVerifiedAnswer,
          });

          if (titlePromise) {
            try {
              const title = await titlePromise;
              dataStream.write({ data: title, type: "data-chat-title" });
              updateChatTitleById({ chatId: id, title });
            } catch {
              /* non-fatal */
            }
          }

          return;
        }

        const result = streamText({
          activeTools: shouldUseImageToolPlanning
            ? ["createDocument"]
            : shouldUpdateExistingImageArtifact
              ? ["updateDocument"]
              : shouldCreateImageArtifact
                ? ["createDocument"]
                : hasCurrentImageAttachment ||
                    (isReasoningModel && !supportsTools)
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
                      ...(shouldExposeArtifactTools
                        ? ([
                            "createDocument",
                            "editDocument",
                            "updateDocument",
                          ] as const)
                        : []),
                      "requestSuggestions",
                    ],
          instructions: `${buildSystemPrompt()}${searchInstructions}${imageToolInstructions}${serverSearchContext}`,
          messages: modelMessages,
          model: getLanguageModel(chatModel),
          onAbort() {
            stopWaitingStatus();
          },
          onChunk({ chunk }) {
            if (isModelStreamActivity(chunk)) {
              markModelActive();
            }
            if (chunk.type === "text-delta" && chunk.text.trim()) {
              hasAssistantText = true;
            }
          },
          onEnd() {
            stopWaitingStatus();
            if (
              fallbackVerifiedAnswer &&
              !shouldUseImageArtifactTool &&
              !hasAssistantText
            ) {
              writeAssistantTextFallback({
                dataStream,
                text: fallbackVerifiedAnswer,
              });
            }
          },
          onError({ error }) {
            stopWaitingStatus();
            console.error("[chat] streamText failed", error);
          },
          providerOptions: {
            ...(modelConfig?.gatewayOrder && {
              gateway: { order: modelConfig.gatewayOrder },
            }),
            ...(modelConfig?.reasoningEffort && {
              openai: { reasoningEffort: modelConfig.reasoningEffort },
            }),
          },
          stopWhen: shouldUseImageArtifactTool
            ? hasToolCall("createDocument", "updateDocument")
            : isStepCount(5),
          telemetry: {
            functionId: "stream-text",
            isEnabled: isProductionEnvironment,
          },
          toolChoice:
            shouldUseImageToolPlanning || shouldCreateImageArtifact
              ? { toolName: "createDocument", type: "tool" }
              : shouldUpdateExistingImageArtifact
                ? { toolName: "updateDocument", type: "tool" }
                : "auto",
          tools: {
            ...createTools(bearerToken),
            createDocument: createDocument({
              dataStream,
              modelId: chatModel,
              session,
              sourceImagePrompt: shouldUseImageArtifactTool
                ? contextualImagePrompt
                : undefined,
              sourceImageUrls: imageSourceUrls,
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
        console.error("[chat] UI stream failed", error);
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
        if (process.env.REDIS_URL) {
          try {
            const streamContext = getStreamContext();
            if (streamContext) {
              const streamId = generateId();
              await createStreamId({ chatId: id, streamId });
              await streamContext.createNewResumableStream(
                streamId,
                () => sseStream
              );
              return;
            }
          } catch {
            /* non-critical */
          }
        }

        await consumeStream({ stream: sseStream });
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
