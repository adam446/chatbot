import { tool, type UIMessageStreamWriter } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { isImageSafetyBlockError } from "@/lib/ai/image-safety";
import {
  artifactKinds,
  documentHandlersByArtifactKind,
} from "@/lib/artifacts/server";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

type CreateDocumentProps = {
  session: Session;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  modelId: string;
  sourceImageUrls?: string[];
  sourceImagePrompt?: string;
};

export const createDocument = ({
  session,
  dataStream,
  modelId,
  sourceImageUrls = [],
  sourceImagePrompt,
}: CreateDocumentProps) =>
  tool({
    description:
      "Create an artifact through this tool call only. Never write createDocument, JSON, or pseudo-code in chat. You MUST specify kind: use 'code' for any programming/algorithm request (creates a script), 'text' for essays/writing (creates a document), 'sheet' for spreadsheets/data, 'image' for image generation or editing from an uploaded image. Image requests always run server-side NVIDIA safety before generation.",
    execute: async ({
      title,
      kind,
      prompt,
      sourceImageUrl,
      referenceImageUrl,
      style,
      negativePrompt,
    }) => {
      const id = generateUUID();
      const imagePromptParts = [
        prompt ?? sourceImagePrompt,
        style ? `Style: ${style}` : null,
        negativePrompt ? `Avoid: ${negativePrompt}` : null,
      ].filter(Boolean);
      const imagePrompt =
        kind === "image" ? imagePromptParts.join("\n") || undefined : undefined;

      dataStream.write({
        data: kind,
        transient: true,
        type: "data-kind",
      });

      dataStream.write({
        data: id,
        transient: true,
        type: "data-id",
      });

      dataStream.write({
        data: title,
        transient: true,
        type: "data-title",
      });

      dataStream.write({
        data: null,
        transient: true,
        type: "data-clear",
      });

      const documentHandler = documentHandlersByArtifactKind.find(
        (documentHandlerByArtifactKind) =>
          documentHandlerByArtifactKind.kind === kind
      );

      if (!documentHandler) {
        throw new Error(`No document handler found for kind: ${kind}`);
      }

      try {
        await documentHandler.onCreateDocument({
          dataStream,
          id,
          modelId,
          prompt: imagePrompt,
          session,
          sourceImageUrl:
            kind === "image"
              ? (sourceImageUrls.at(-1) ??
                sourceImageUrl ??
                referenceImageUrl ??
                undefined)
              : undefined,
          title,
        });
      } catch (error) {
        dataStream.write({ data: null, transient: true, type: "data-finish" });

        if (isImageSafetyBlockError(error)) {
          return {
            blocked: true,
            categories: error.categories,
            error: error.message,
            id,
            kind,
            reason: error.reason,
            title,
          };
        }

        if (kind === "image") {
          return {
            error:
              error instanceof Error
                ? `Image generation failed closed: ${error.message}`
                : "Image generation failed closed.",
            id,
            kind,
            title,
          };
        }

        throw error;
      }

      dataStream.write({ data: null, transient: true, type: "data-finish" });

      return {
        content:
          kind === "code"
            ? "A script was created and is now visible to the user."
            : kind === "image"
              ? "An image was created and is now visible to the user."
              : "A document was created and is now visible to the user.",
        id,
        kind,
        title,
      };
    },
    inputSchema: z.object({
      kind: z
        .enum(artifactKinds)
        .describe(
          "REQUIRED. 'code' for programming/algorithms, 'text' for essays/writing, 'sheet' for spreadsheets, 'image' for image generation or image editing"
        ),
      negativePrompt: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional image constraints to avoid. The server folds this into the final prompt because not all image providers support a separate negative prompt field."
        ),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
          "For image artifacts, the full generation/edit instruction. Use the user's exact requested transformation, including constraints like preserving identity, face, pose, background, style, and original colors."
        ),
      referenceImageUrl: z
        .string()
        .min(1)
        .nullable()
        .optional()
        .describe(
          "Optional alias for sourceImageUrl. Use only when the user provides a reference image URL and there is no uploaded image."
        ),
      sourceImageUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional. For editing an uploaded PNG/JPEG, pass the attachment URL from the user's message. Leave empty for text-to-image generation."
        ),
      style: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional image style constraint, such as photorealistic, cinematic, pencil sketch, or product render."
        ),
      title: z.string().describe("The title of the artifact"),
    }),
  });
