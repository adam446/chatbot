import {
  evaluateImageSafety,
  ImageSafetyBlockError,
} from "@/lib/ai/image-safety";
import { fetchImageAsBase64, generateNvidiaImage } from "@/lib/ai/nvidia-image";
import { createDocumentHandler } from "@/lib/artifacts/server";

export const imageDocumentHandler = createDocumentHandler<"image">({
  kind: "image",
  onCreateDocument: async ({ title, dataStream, sourceImageUrl }) => {
    const safety = await evaluateImageSafety({
      mode: sourceImageUrl ? "edit" : "create",
      prompt: title,
      sourceImagePresent: Boolean(sourceImageUrl),
    });

    if (!safety.allowed) {
      throw new ImageSafetyBlockError(safety);
    }

    const sourceImage = sourceImageUrl
      ? await fetchImageAsBase64(sourceImageUrl)
      : null;

    const image = await generateNvidiaImage({
      prompt: title,
      sourceImageBase64: sourceImage?.base64,
      sourceImageMimeType: sourceImage?.mimeType,
    });

    dataStream.write({
      data: image,
      transient: true,
      type: "data-imageDelta",
    });

    return image;
  },
  onUpdateDocument: async ({ document, description, dataStream }) => {
    const safety = await evaluateImageSafety({
      mode: "edit",
      prompt: description,
      sourceImagePresent: true,
    });

    if (!safety.allowed) {
      throw new ImageSafetyBlockError(safety);
    }

    const image = await generateNvidiaImage({
      prompt: description,
      sourceImageBase64: document.content ?? undefined,
      sourceImageMimeType: "image/png",
    });

    dataStream.write({
      data: image,
      transient: true,
      type: "data-imageDelta",
    });

    return image;
  },
});
