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
};

export const createDocument = ({
  session,
  dataStream,
  modelId,
  sourceImageUrls = [],
}: CreateDocumentProps) =>
  tool({
    description:
      "Create an artifact. You MUST specify kind: use 'code' for any programming/algorithm request (creates a script), 'text' for essays/writing (creates a document), 'sheet' for spreadsheets/data, 'image' for image generation or editing from an uploaded image. Image requests always run server-side NVIDIA safety before generation.",
    execute: async ({ title, kind, sourceImageUrl }) => {
      const id = generateUUID();

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
          session,
          sourceImageUrl:
            kind === "image"
              ? (sourceImageUrls.at(-1) ?? sourceImageUrl)
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
      sourceImageUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional. For editing an uploaded PNG/JPEG, pass the attachment URL from the user's message. Leave empty for text-to-image generation."
        ),
      title: z.string().describe("The title of the artifact"),
    }),
  });
