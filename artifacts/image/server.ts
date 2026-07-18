import {
  evaluateImageSafety,
  ImageSafetyBlockError,
} from "@/lib/ai/image-safety";
import { chatModels } from "@/lib/ai/models";
import { fetchImageAsBase64, generateNvidiaImage } from "@/lib/ai/nvidia-image";
import { createDocumentHandler } from "@/lib/artifacts/server";

function canSendSourceImageToNvidia() {
  return process.env.NVIDIA_IMAGE_ENABLE_SOURCE_EDIT === "1";
}

function getModelName(modelId: string) {
  return chatModels.find((model) => model.id === modelId)?.name ?? modelId;
}

export const imageDocumentHandler = createDocumentHandler<"image">({
  kind: "image",
  onCreateDocument: async ({ title, dataStream, modelId, sourceImageUrl }) => {
    dataStream.write({
      data: {
        message: "Checking image safety...",
        modelId,
        modelName: getModelName(modelId),
        phase: "waiting",
      },
      transient: true,
      type: "data-waiting-status",
    });

    const safety = await evaluateImageSafety({
      mode: sourceImageUrl ? "edit" : "create",
      prompt: title,
      sourceImagePresent: Boolean(sourceImageUrl),
    });

    if (!safety.allowed) {
      throw new ImageSafetyBlockError(safety);
    }

    if (sourceImageUrl) {
      dataStream.write({
        data: {
          message: "Reading uploaded image...",
          modelId,
          modelName: getModelName(modelId),
          phase: "waiting",
        },
        transient: true,
        type: "data-waiting-status",
      });
    }

    const sourceImage = sourceImageUrl
      ? await fetchImageAsBase64(sourceImageUrl)
      : null;
    const sendSourceImage = Boolean(
      sourceImage && canSendSourceImageToNvidia()
    );

    dataStream.write({
      data: {
        message: sourceImage
          ? "Generating image from the upload..."
          : "Generating image...",
        modelId,
        modelName: getModelName(modelId),
        phase: "thinking",
      },
      transient: true,
      type: "data-waiting-status",
    });

    const image = await generateNvidiaImage({
      prompt:
        sourceImage && !sendSourceImage
          ? `${title}. Create a new image inspired by the uploaded reference image.`
          : title,
      sourceImageBase64: sendSourceImage ? sourceImage?.base64 : undefined,
      sourceImageMimeType: sendSourceImage ? sourceImage?.mimeType : undefined,
    });

    dataStream.write({
      data: image,
      transient: true,
      type: "data-imageDelta",
    });

    return image;
  },
  onUpdateDocument: async ({ document, description, dataStream, modelId }) => {
    dataStream.write({
      data: {
        message: "Checking image safety...",
        modelId,
        modelName: getModelName(modelId),
        phase: "waiting",
      },
      transient: true,
      type: "data-waiting-status",
    });

    const safety = await evaluateImageSafety({
      mode: "edit",
      prompt: description,
      sourceImagePresent: true,
    });

    if (!safety.allowed) {
      throw new ImageSafetyBlockError(safety);
    }

    const sendSourceImage = canSendSourceImageToNvidia();
    dataStream.write({
      data: {
        message: "Generating updated image...",
        modelId,
        modelName: getModelName(modelId),
        phase: "thinking",
      },
      transient: true,
      type: "data-waiting-status",
    });

    const image = await generateNvidiaImage({
      prompt: description,
      sourceImageBase64: sendSourceImage
        ? (document.content ?? undefined)
        : undefined,
      sourceImageMimeType: sendSourceImage ? "image/png" : undefined,
    });

    dataStream.write({
      data: image,
      transient: true,
      type: "data-imageDelta",
    });

    return image;
  },
});
