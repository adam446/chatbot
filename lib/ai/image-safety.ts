import { generateText } from "ai";
import { z } from "zod";
import { getLanguageModel } from "./providers";

const DEFAULT_SAFETY_MODEL = "nvidia:nvidia/llama-3.1-nemotron-safety-8b-v1";

const safetyResultSchema = z.object({
  allowed: z.boolean(),
  categories: z.array(z.string()).default([]),
  reason: z.string().min(1),
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

export async function evaluateImageSafety({
  mode,
  prompt,
  sourceImagePresent = false,
}: {
  mode: ImageSafetyMode;
  prompt: string;
  sourceImagePresent?: boolean;
}): Promise<ImageSafetyResult> {
  try {
    const { text } = await generateText({
      model: getLanguageModel(getSafetyModelId()),
      prompt: `Evaluate this image ${mode} request before any image model runs.

Policy:
- Allow fictional graphic violence, gore, horror, injuries, monsters, battle scenes, and stylized violent artwork.
- Block illegal content only, including sexual content involving minors, sexual exploitation, non-consensual intimate imagery, doxxing, credential theft, fraud, operational illegal weapons/explosives guidance, evasion of law enforcement, and explicit requests to depict a real person committing an illegal act.
- If unsure whether the request is illegal, block.

Return ONLY compact JSON with this exact shape:
{"allowed":boolean,"categories":["category"],"reason":"detailed reason"}

Source image attached: ${sourceImagePresent ? "yes" : "no"}
Request:
${prompt}`,
      temperature: 0,
    });

    return parseSafetyJson(text);
  } catch (error) {
    return {
      allowed: false,
      categories: ["safety_unavailable"],
      reason:
        error instanceof Error
          ? `Safety check failed closed: ${error.message}`
          : "Safety check failed closed.",
    };
  }
}
