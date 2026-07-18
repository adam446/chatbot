import { inflateSync } from "node:zlib";
import { get } from "@vercel/blob";
import { z } from "zod";

const DEFAULT_IMAGE_MODEL = "black-forest-labs/flux.1-dev";
const DEFAULT_IMAGE_EDIT_MODEL = "qwen/qwen-image-edit-2511";
const DEFAULT_DEEPINFRA_IMAGE_EDIT_MODEL = "Qwen/Qwen-Image-Edit";
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_CFG_SCALE = 5;
const DEFAULT_IMAGE_TIMEOUT_MS = 45_000;
const DEFAULT_IMAGE_EDIT_TIMEOUT_MS = 25_000;
const MAX_IMAGE_EDIT_TIMEOUT_MS = 45_000;
const DEFAULT_SEED = 0;
const DEFAULT_STEPS = 8;
const DEFAULT_IMAGE_EDIT_SIZE = "512x512";
const DEFAULT_DEEPINFRA_IMAGE_EDIT_URL =
  "https://api.deepinfra.com/v1/openai/images/edits";
const DEEPINFRA_IMAGE_EDIT_MODEL_ALIASES: Record<string, string> = {
  "black-forest-labs/flux-2-klein-4b": "black-forest-labs/FLUX-2-klein-4b",
  "black-forest-labs/flux.2-klein-4b": "black-forest-labs/FLUX-2-klein-4b",
  "qwen/qwen-image-edit": DEFAULT_DEEPINFRA_IMAGE_EDIT_MODEL,
  "qwen/qwen-image-edit-2509": DEFAULT_DEEPINFRA_IMAGE_EDIT_MODEL,
  "qwen/qwen-image-edit-2511": DEFAULT_DEEPINFRA_IMAGE_EDIT_MODEL,
  "qwen/qwen-image-edit-max": "Qwen/Qwen-Image-Edit-Max",
};

type NvidiaImageRequest = {
  prompt: string;
  sourceImageBase64?: string;
  sourceImageMimeType?: string;
};

type PngInfo = {
  bitDepth: number;
  colorType: number;
  data: Buffer;
  height: number;
  width: number;
};

const stringRecordSchema = z.record(z.string(), z.unknown());

function getImageModel() {
  return process.env.NVIDIA_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
}

function getImageEditProvider() {
  return process.env.NVIDIA_IMAGE_EDIT_PROVIDER?.toLowerCase();
}

function normalizeDeepInfraImageEditModel(model: string) {
  return DEEPINFRA_IMAGE_EDIT_MODEL_ALIASES[model.toLowerCase()] ?? model;
}

function getImageEditModel() {
  if (getImageEditProvider() === "deepinfra") {
    return normalizeDeepInfraImageEditModel(
      process.env.NVIDIA_IMAGE_EDIT_MODEL ?? DEFAULT_DEEPINFRA_IMAGE_EDIT_MODEL
    );
  }

  return process.env.NVIDIA_IMAGE_EDIT_MODEL ?? DEFAULT_IMAGE_EDIT_MODEL;
}

function getImageApiUrl(hasSourceImage: boolean) {
  if (hasSourceImage && getImageEditProvider() === "deepinfra") {
    return (
      process.env.NVIDIA_IMAGE_EDIT_API_URL ?? DEFAULT_DEEPINFRA_IMAGE_EDIT_URL
    );
  }

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

function getImageApiKey(hasSourceImage: boolean) {
  if (hasSourceImage) {
    return process.env.NVIDIA_IMAGE_EDIT_API_KEY ?? process.env.NVIDIA_API_KEY;
  }

  return process.env.NVIDIA_API_KEY;
}

function stripDataUrlPrefix(value: string) {
  return value.replace(/^data:image\/(?:png|jpeg|jpg|webp);base64,/i, "");
}

function assertValidGeneratedImage(base64: string) {
  const imageBuffer = Buffer.from(base64, "base64");

  if (imageBuffer.length < 2048) {
    throw new Error("Generated image was too small to be valid");
  }

  if (
    imageBuffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    assertPngIsVisible(imageBuffer);
  }
}

function readUInt32(buffer: Buffer, offset: number) {
  if (offset + 4 > buffer.length) {
    throw new Error("Generated PNG is truncated");
  }

  return buffer.readUInt32BE(offset);
}

function parsePng(buffer: Buffer): PngInfo {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const length = readUInt32(buffer, offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) {
      throw new Error("Generated PNG is truncated");
    }

    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      [, , , , , , , , bitDepth, colorType] = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || idatChunks.length === 0) {
    throw new Error("Generated PNG is missing image data");
  }

  return {
    bitDepth,
    colorType,
    data: inflateSync(Buffer.concat(idatChunks)),
    height,
    width,
  };
}

function bytesPerPixel({
  bitDepth,
  colorType,
}: Pick<PngInfo, "bitDepth" | "colorType">) {
  if (bitDepth !== 8) {
    return null;
  }

  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return null;
  }
}

function unfilterPngScanline({
  bpp,
  current,
  filter,
  previous,
}: {
  bpp: number;
  current: Buffer;
  filter: number;
  previous: Buffer;
}) {
  for (let i = 0; i < current.length; i += 1) {
    const left = i >= bpp ? current[i - bpp] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? previous[i - bpp] : 0;

    if (filter === 1) {
      current[i] = (current[i] + left) & 0xff;
    } else if (filter === 2) {
      current[i] = (current[i] + up) & 0xff;
    } else if (filter === 3) {
      current[i] = (current[i] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      current[i] = (current[i] + predictor) & 0xff;
    } else if (filter !== 0) {
      throw new Error("Generated PNG uses an unsupported filter");
    }
  }
}

function assertPngIsVisible(buffer: Buffer) {
  const png = parsePng(buffer);
  const bpp = bytesPerPixel(png);

  if (!bpp) {
    return;
  }

  const stride = png.width * bpp;
  let offset = 0;
  let previous = Buffer.alloc(stride);
  let sampledPixels = 0;
  let visiblePixels = 0;
  let brightnessTotal = 0;

  for (let y = 0; y < png.height; y += 1) {
    const filter = png.data[offset];
    const current = Buffer.from(
      png.data.subarray(offset + 1, offset + 1 + stride)
    );
    unfilterPngScanline({ bpp, current, filter, previous });

    const step = Math.max(1, Math.floor(png.width / 128));
    for (let x = 0; x < png.width; x += step) {
      const pixelOffset = x * bpp;
      const alpha =
        png.colorType === 4 || png.colorType === 6
          ? current[pixelOffset + bpp - 1]
          : 255;
      if (alpha > 12) {
        const red = current[pixelOffset];
        const green =
          png.colorType === 0 || png.colorType === 4
            ? red
            : current[pixelOffset + 1];
        const blue =
          png.colorType === 0 || png.colorType === 4
            ? red
            : current[pixelOffset + 2];
        const brightness = (red + green + blue) / 3;
        brightnessTotal += brightness;
        visiblePixels += 1;
      }
      sampledPixels += 1;
    }

    previous = current;
    offset += stride + 1;
  }

  if (sampledPixels === 0 || visiblePixels / sampledPixels < 0.05) {
    throw new Error("Generated image appears blank or transparent");
  }

  if (visiblePixels > 0 && brightnessTotal / visiblePixels < 3) {
    throw new Error("Generated image appears black or empty");
  }
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
  if (sourceImageBase64) {
    const payload: Record<string, unknown> = {
      image: `data:${sourceImageMimeType ?? "image/png"};base64,${sourceImageBase64}`,
      prompt,
      seed: getNumberEnv("NVIDIA_IMAGE_SEED", DEFAULT_SEED),
    };

    if (process.env.NVIDIA_IMAGE_INCLUDE_MODEL === "1") {
      payload.model = getImageEditModel();
    }

    return payload;
  }

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
    payload.model = getImageModel();
  }
  payload.mode = "base";

  return payload;
}

function buildDeepInfraImageEditBody({
  prompt,
  sourceImageBase64,
  sourceImageMimeType,
}: NvidiaImageRequest) {
  if (!sourceImageBase64) {
    throw new Error("DeepInfra image editing requires a source image");
  }

  const imageBuffer = Buffer.from(sourceImageBase64, "base64");
  const body = new FormData();
  const mimeType = sourceImageMimeType ?? "image/png";
  const extension =
    mimeType === "image/jpeg" ? "jpg" : mimeType.replace("image/", "");

  body.append(
    "image",
    new Blob([imageBuffer], { type: mimeType }),
    `source.${extension}`
  );
  body.append("prompt", prompt);
  body.append("model", getImageEditModel());
  body.append("n", "1");
  body.append(
    "size",
    process.env.NVIDIA_IMAGE_EDIT_SIZE ?? DEFAULT_IMAGE_EDIT_SIZE
  );

  return body;
}

function getImageTimeoutMs(hasSourceImage = false) {
  if (hasSourceImage) {
    return Math.min(
      getNumberEnv(
        "NVIDIA_IMAGE_EDIT_TIMEOUT_MS",
        DEFAULT_IMAGE_EDIT_TIMEOUT_MS
      ),
      MAX_IMAGE_EDIT_TIMEOUT_MS
    );
  }

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
  const hasSourceImage = Boolean(sourceImageBase64);
  const apiKey = getImageApiKey(hasSourceImage);
  if (!apiKey) {
    throw new Error(
      hasSourceImage
        ? "NVIDIA_IMAGE_EDIT_API_KEY or NVIDIA_API_KEY is required for image editing"
        : "NVIDIA_API_KEY is required for image generation"
    );
  }

  if (
    sourceImageBase64 &&
    getImageEditProvider() !== "deepinfra" &&
    !(process.env.NVIDIA_IMAGE_EDIT_API_URL || process.env.NVIDIA_IMAGE_API_URL)
  ) {
    throw new Error(
      "NVIDIA hosted image generation does not support arbitrary uploaded source images. Configure NVIDIA_IMAGE_EDIT_API_URL for a self-hosted image-edit NIM before enabling source edits."
    );
  }

  let response: Response;
  const imageTimeoutMs = getImageTimeoutMs(hasSourceImage);
  try {
    if (sourceImageBase64 && getImageEditProvider() === "deepinfra") {
      response = await fetch(getImageApiUrl(true), {
        body: buildDeepInfraImageEditBody({
          prompt,
          sourceImageBase64,
          sourceImageMimeType,
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        method: "POST",
        signal: AbortSignal.timeout(imageTimeoutMs),
      });
    } else {
      response = await fetch(getImageApiUrl(hasSourceImage), {
        body: JSON.stringify(
          buildPayload({ prompt, sourceImageBase64, sourceImageMimeType })
        ),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(imageTimeoutMs),
      });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error(
        `NVIDIA image request timed out after ${imageTimeoutMs}ms`,
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
    const image = Buffer.from(await response.arrayBuffer()).toString("base64");
    assertValidGeneratedImage(image);
    return image;
  }

  const json = await response.json();
  const image = extractImageBase64(json);
  if (!image) {
    throw new Error("NVIDIA image response did not include base64 image data");
  }
  assertValidGeneratedImage(image);

  return image;
}
