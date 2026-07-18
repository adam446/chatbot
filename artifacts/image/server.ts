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

function normalizePrompt(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getImageEditClarification(prompt: string) {
  const normalized = normalizePrompt(prompt);
  const words = normalized.split(/\s+/).filter(Boolean);
  const vagueReference =
    /\b(ca|cela|ceci|this|that|it|thing|truc|image|photo)\b/.test(normalized);
  const hasAction =
    /\b(change|modifier|modifie|remplace|remplacer|ajoute|ajouter|enleve|enlever|ameliore|ameliorer|edit|modify|replace|add|remove|improve|transform)\b/.test(
      normalized
    );
  const hasConcreteTarget =
    /\b(vetement|tenue|habit|chemise|manteau|blouse|couleur|fond|background|visage|face|cheveux|hair|yeux|eyes|style|pose|personnage|character|logo|texte|text|shirt|coat|clothes|outfit|uniform)\b/.test(
      normalized
    );

  if (words.length < 3 || (hasAction && vagueReference && !hasConcreteTarget)) {
    return "Clarification needed: please specify exactly what to change in the image and what should stay unchanged.";
  }

  return null;
}

function buildImagePrompt({
  mode,
  prompt,
}: {
  mode: "create" | "edit";
  prompt: string;
}) {
  if (mode === "create") {
    return `${prompt}\n\nGenerate a complete, visible, non-empty image. Do not generate a blank, solid black, transparent, mask-only, or alpha-only output.`;
  }

  return `${prompt}

Edit the source image directly. Preserve the same subject identity, face, pose, framing, background, line art, visual style, and original colors unless the user explicitly asked to change one of those. Change only the requested elements. Return a complete visible image, not a mask, not an alpha map, not a blank frame, and not a solid black image.`;
}

export const imageDocumentHandler = createDocumentHandler<"image">({
  kind: "image",
  onCreateDocument: async ({
    title,
    prompt,
    dataStream,
    modelId,
    sourceImageUrl,
  }) => {
    const imagePrompt = prompt ?? title;
    const editClarification = sourceImageUrl
      ? getImageEditClarification(imagePrompt)
      : null;

    if (editClarification) {
      throw new Error(editClarification);
    }
    const generationPrompt = buildImagePrompt({
      mode: sourceImageUrl ? "edit" : "create",
      prompt: imagePrompt,
    });

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
      prompt: generationPrompt,
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

    if (sourceImage && !sendSourceImage) {
      throw new Error(
        "Uploaded image editing is not configured. Set NVIDIA_IMAGE_EDIT_API_URL and NVIDIA_IMAGE_ENABLE_SOURCE_EDIT=1 to enable source-image edits."
      );
    }

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
      prompt: generationPrompt,
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
    const editClarification = getImageEditClarification(description);

    if (editClarification) {
      throw new Error(editClarification);
    }

    const generationPrompt = buildImagePrompt({
      mode: "edit",
      prompt: description,
    });

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
      prompt: generationPrompt,
      sourceImagePresent: true,
    });

    if (!safety.allowed) {
      throw new ImageSafetyBlockError(safety);
    }

    const sendSourceImage = canSendSourceImageToNvidia();
    if (!sendSourceImage) {
      throw new Error(
        "Uploaded image editing is not configured. Set NVIDIA_IMAGE_EDIT_API_URL and NVIDIA_IMAGE_ENABLE_SOURCE_EDIT=1 to enable source-image edits."
      );
    }

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
      prompt: generationPrompt,
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
