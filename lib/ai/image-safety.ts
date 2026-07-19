import { generateText } from "ai";
import { z } from "zod";
import { DEFAULT_MODEL } from "./models";
import { getLanguageModel } from "./providers";

const DEFAULT_SAFETY_MODEL = DEFAULT_MODEL;

const safetyResultSchema = z.object({
  allowed: z.boolean(),
  categories: z.array(z.string()).default([]),
  reason: z.string().min(1),
  subjectType: z.enum(["fictional", "real", "unknown"]).default("unknown"),
});

export type ImageSafetyMode = "create" | "edit";

export type ImageSafetyResult = z.infer<typeof safetyResultSchema>;

export class ImageSafetyBlockError extends Error {
  categories: string[];
  reason: string;

  constructor(result: ImageSafetyResult) {
    super(
      `Image safety blocked this request. Categories: ${result.categories.join(", ") || "unknown"}. Reason: ${result.reason}`
    );
    this.name = "ImageSafetyBlockError";
    this.categories = result.categories;
    this.reason = result.reason;
  }
}

export function isImageSafetyBlockError(
  error: unknown
): error is ImageSafetyBlockError {
  return error instanceof ImageSafetyBlockError;
}

function getSafetyModelId() {
  const configured = process.env.NVIDIA_SAFETY_MODEL ?? DEFAULT_SAFETY_MODEL;
  return configured.startsWith("nvidia:") ? configured : `nvidia:${configured}`;
}

function getSafetyModelIds() {
  return [...new Set([getSafetyModelId(), DEFAULT_MODEL])];
}

function parseSafetyJson(text: string): ImageSafetyResult {
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  const candidate =
    firstBrace >= 0 && lastBrace > firstBrace
      ? withoutFence.slice(firstBrace, lastBrace + 1)
      : withoutFence;

  return safetyResultSchema.parse(JSON.parse(candidate));
}

async function evaluateWithFallbackModels({
  index,
  modelIds,
  prompt,
  sourceImageBase64,
  sourceImageMimeType,
}: {
  index: number;
  modelIds: string[];
  prompt: string;
  sourceImageBase64?: string;
  sourceImageMimeType?: string;
}): Promise<ImageSafetyResult> {
  const modelId = modelIds[index];

  if (!modelId) {
    throw new Error("No NVIDIA safety model returned a valid response");
  }

  try {
    const { text: responseText } = await generateText({
      messages: [
        {
          content: [
            { text: prompt, type: "text" },
            ...(sourceImageBase64
              ? [
                  {
                    image: Buffer.from(sourceImageBase64, "base64"),
                    mediaType: sourceImageMimeType ?? "image/png",
                    type: "image" as const,
                  },
                ]
              : []),
          ],
          role: "user",
        },
      ],
      model: getLanguageModel(modelId),
      temperature: 0,
    });

    return parseSafetyJson(responseText);
  } catch (error) {
    if (index >= modelIds.length - 1) {
      throw error;
    }

    return evaluateWithFallbackModels({
      index: index + 1,
      modelIds,
      prompt,
      sourceImageBase64,
      sourceImageMimeType,
    });
  }
}

export async function evaluateImageSafety({
  mode,
  prompt,
  sourceImagePresent = false,
  sourceImageBase64,
  sourceImageMimeType,
}: {
  mode: ImageSafetyMode;
  prompt: string;
  sourceImagePresent?: boolean;
  sourceImageBase64?: string;
  sourceImageMimeType?: string;
}): Promise<ImageSafetyResult> {
  const promptText = `Evaluate this image ${mode} request before any image model runs.

Policy:
- Allow fictional graphic violence, gore, horror, injuries, monsters, battle scenes, and stylized violent artwork.
- Allow a mug-shot-style portrait of an explicitly fictional character. A fictional character is not a real identity and should not be classified as doxxing solely because the requested framing resembles an administrative or mug-shot portrait.
- Block illegal content only, including sexual content involving minors, sexual exploitation, non-consensual intimate imagery, doxxing, credential theft, fraud, operational illegal weapons/explosives guidance, evasion of law enforcement, and explicit requests to depict a real person committing an illegal act.
- If the subject is a real person or the subject type cannot be established, block doxxing or identity-risk requests. If unsure whether the request is illegal, block.

Return ONLY compact JSON with this exact shape:
{"allowed":boolean,"categories":["category"],"reason":"detailed reason","subjectType":"fictional|real|unknown"}

Source image attached: ${sourceImagePresent ? "yes" : "no"}
Request:
${prompt}`;

  try {
    const result = await evaluateWithFallbackModels({
      index: 0,
      modelIds: getSafetyModelIds(),
      prompt: promptText,
      sourceImageBase64,
      sourceImageMimeType,
    });

    const onlyDoxxing =
      result.categories.length > 0 &&
      result.categories.every((category) => category === "doxxing");
    if (onlyDoxxing && result.subjectType === "fictional") {
      return {
        ...result,
        allowed: true,
        categories: [],
        reason:
          "The subject was classified as fictional; the mug-shot-style framing does not identify a real person.",
      };
    }

    return result;
  } catch (error) {
    return {
      allowed: false,
      categories: ["safety_unavailable"],
      reason:
        error instanceof Error
          ? `Safety check failed closed: ${error.message}`
          : "Safety check failed closed.",
      subjectType: "unknown",
    };
  }
}
