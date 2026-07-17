import { get } from "@vercel/blob";
import { z } from "zod";

const DEFAULT_IMAGE_MODEL = "black-forest-labs/flux.1-dev";
const DEFAULT_IMAGE_EDIT_MODEL = "black-forest-labs/flux.1-kontext-dev";
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_CFG_SCALE = 5;
const DEFAULT_IMAGE_TIMEOUT_MS = 45_000;
const DEFAULT_SEED = 0;
const DEFAULT_STEPS = 8;

type NvidiaImageRequest = {
  prompt: string;
  sourceImageBase64?: string;
  sourceImageMimeType?: string;
};

const stringRecordSchema = z.record(z.string(), z.unknown());

function getImageModel() {
  return process.env.NVIDIA_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
}

function getImageEditModel() {
  return process.env.NVIDIA_IMAGE_EDIT_MODEL ?? DEFAULT_IMAGE_EDIT_MODEL;
}

function getImageApiUrl(hasSourceImage: boolean) {
  if (hasSourceImage && process.env.NVIDIA_IMAGE_EDIT_API_URL) {
    return process.env.NVIDIA_IMAGE_EDIT_API_URL;
  }

  if (process.env.NVIDIA_IMAGE_API_URL) {
    return process.env.NVIDIA_IMAGE_API_URL;
  }

  const model = hasSourceImage ? getImageEditModel() : getImageModel();

  return `https://ai.api.nvidia.com/v1/genai/${model}`;
}

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stripDataUrlPrefix(value: string) {
  return value.replace(/^data:image\/(?:png|jpeg|jpg|webp);base64,/i, "");
}

function extractImageBase64(value: unknown): string | null {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      return stripDataUrlPrefix(value);
    }

    if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 100) {
      return value.replace(/\s/g, "");
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractImageBase64(item);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  const object = stringRecordSchema.parse(value);
  const candidateKeys = [
    "b64_json",
    "base64",
    "image",
    "image_base64",
    "imageBase64",
    "data",
    "content",
  ];

  for (const key of candidateKeys) {
    const extracted = extractImageBase64(object[key]);
    if (extracted) {
      return extracted;
    }
  }

  for (const key of ["artifacts", "images", "output", "outputs", "result"]) {
    const extracted = extractImageBase64(object[key]);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function buildPayload({
  prompt,
  sourceImageBase64,
  sourceImageMimeType,
}: NvidiaImageRequest) {
  const payload: Record<string, unknown> = {
    cfg_scale: getNumberEnv("NVIDIA_IMAGE_CFG_SCALE", DEFAULT_CFG_SCALE),
    height: getNumberEnv("NVIDIA_IMAGE_HEIGHT", DEFAULT_HEIGHT),
    prompt,
    samples: 1,
    seed: getNumberEnv("NVIDIA_IMAGE_SEED", DEFAULT_SEED),
    steps: getNumberEnv("NVIDIA_IMAGE_STEPS", DEFAULT_STEPS),
    width: getNumberEnv("NVIDIA_IMAGE_WIDTH", DEFAULT_WIDTH),
  };

  if (process.env.NVIDIA_IMAGE_INCLUDE_MODEL === "1") {
    payload.model = sourceImageBase64 ? getImageEditModel() : getImageModel();
  }

  if (sourceImageBase64) {
    payload.image = `data:${sourceImageMimeType ?? "image/png"};base64,${sourceImageBase64}`;
  } else {
    payload.mode = "base";
  }

  return payload;
}

function getImageTimeoutMs() {
  return getNumberEnv("NVIDIA_IMAGE_TIMEOUT_MS", DEFAULT_IMAGE_TIMEOUT_MS);
}

function getPrivateBlobPathnameFromUrl(value: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value, "http://localhost");
  } catch {
    return null;
  }

  if (parsedUrl.pathname.endsWith("/api/files/view")) {
    return parsedUrl.searchParams.get("pathname");
  }

  const nestedImageUrl =
    parsedUrl.pathname.endsWith("/_next/image") &&
    parsedUrl.searchParams.get("url");

  if (nestedImageUrl) {
    return getPrivateBlobPathnameFromUrl(nestedImageUrl);
  }

  return null;
}

async function fetchPrivateBlobImageAsBase64(pathname: string) {
  const result = await get(pathname, {
    access: "private",
    useCache: false,
  });

  if (result?.statusCode !== 200) {
    throw new Error("Could not fetch source image from private Blob store");
  }

  const { contentType } = result.blob;
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new Error("Source image must be PNG, JPEG, or WebP");
  }

  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());

  return {
    base64: buffer.toString("base64"),
    mimeType: contentType,
  };
}

export async function fetchImageAsBase64(url: string) {
  if (url.startsWith("data:image/")) {
    const mimeType = url
      .match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,/i)?.[1]
      ?.replace("image/jpg", "image/jpeg");
    const base64 = extractImageBase64(url);

    if (!mimeType || !base64) {
      throw new Error("Source image data URL is invalid");
    }

    return { base64, mimeType };
  }

  const blobPathname = getPrivateBlobPathnameFromUrl(url);
  if (blobPathname) {
    return fetchPrivateBlobImageAsBase64(blobPathname);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not fetch source image (${response.status})`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(
        contentType.split(";")[0]
      )
    ) {
      throw new Error("Source image must be PNG, JPEG, or WebP");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      base64: buffer.toString("base64"),
      mimeType: contentType.split(";")[0],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "fetch failed";
    throw new Error(`Could not fetch source image: ${message}`, {
      cause: error,
    });
  }
}

export async function generateNvidiaImage({
  prompt,
  sourceImageBase64,
  sourceImageMimeType,
}: NvidiaImageRequest) {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is required for image generation");
  }

  let response: Response;
  try {
    response = await fetch(getImageApiUrl(Boolean(sourceImageBase64)), {
      body: JSON.stringify(
        buildPayload({ prompt, sourceImageBase64, sourceImageMimeType })
      ),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(getImageTimeoutMs()),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        `NVIDIA image request timed out after ${getImageTimeoutMs()}ms`,
        { cause: error }
      );
    }

    throw error;
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `NVIDIA image request failed (${response.status})${details ? `: ${details}` : ""}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) {
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  }

  const json = await response.json();
  const image = extractImageBase64(json);
  if (!image) {
    throw new Error("NVIDIA image response did not include base64 image data");
  }

  return image;
}
