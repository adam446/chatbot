import { tool, type UIMessageStreamWriter } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { isImageSafetyBlockError } from "@/lib/ai/image-safety";
import { documentHandlersByArtifactKind } from "@/lib/artifacts/server";
import { getDocumentById } from "@/lib/db/queries";
import type { ChatMessage } from "@/lib/types";

type UpdateDocumentProps = {
  session: Session;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  modelId: string;
};

export const updateDocument = ({
  session,
  dataStream,
  modelId,
}: UpdateDocumentProps) =>
  tool({
    description:
      "Full rewrite of an existing artifact. Use this to modify existing image artifacts when the user asks to add, remove, replace, restyle, or change anything in the current image. Do not create a new image artifact for follow-up image edits. Prefer editDocument for targeted non-image changes.",
    execute: async ({ id, description }) => {
      const document = await getDocumentById({ id });

      if (!document) {
        return {
          error: "Document not found",
        };
      }

      if (document.userId !== session.user?.id) {
        return { error: "Forbidden" };
      }

      if (document.kind === "image") {
        dataStream.write({
          data: document.kind,
          transient: true,
          type: "data-kind",
        });
        dataStream.write({
          data: document.id,
          transient: true,
          type: "data-id",
        });
        dataStream.write({
          data: document.title,
          transient: true,
          type: "data-title",
        });
      } else {
        dataStream.write({
          data: null,
          transient: true,
          type: "data-clear",
        });
      }

      const documentHandler = documentHandlersByArtifactKind.find(
        (documentHandlerByArtifactKind) =>
          documentHandlerByArtifactKind.kind === document.kind
      );

      if (!documentHandler) {
        throw new Error(`No document handler found for kind: ${document.kind}`);
      }

      try {
        await documentHandler.onUpdateDocument({
          dataStream,
          description,
          document,
          modelId,
          session,
        });
      } catch (error) {
        dataStream.write({ data: null, transient: true, type: "data-finish" });

        if (isImageSafetyBlockError(error)) {
          return {
            blocked: true,
            categories: error.categories,
            error: error.message,
            id,
            kind: document.kind,
            reason: error.reason,
            title: document.title,
          };
        }

        if (document.kind === "image") {
          return {
            error:
              error instanceof Error
                ? `Image editing failed closed: ${error.message}`
                : "Image editing failed closed.",
            id,
            kind: document.kind,
            title: document.title,
          };
        }

        throw error;
      }

      dataStream.write({ data: null, transient: true, type: "data-finish" });

      return {
        content:
          document.kind === "code"
            ? "The script has been updated successfully."
            : document.kind === "image"
              ? "The image has been updated successfully."
              : "The document has been updated successfully.",
        id,
        kind: document.kind,
        title: document.title,
      };
    },
    inputSchema: z.object({
      description: z
        .string()
        .default("Improve the content")
        .describe("The description of changes that need to be made"),
      id: z.string().describe("The ID of the artifact to rewrite"),
    }),
  });
