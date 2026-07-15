---
name: NVIDIA AI
description: Use when the user asks about NVIDIA models, NVIDIA-hosted chat, NVIDIA image generation or editing, NVIDIA safety checks, or debugging NVIDIA API/model configuration.
---

# NVIDIA AI

Use this skill when the user asks for NVIDIA-specific behavior, model selection, image generation, image editing, safety checks, or NVIDIA API debugging.

## Available NVIDIA Capabilities

- Chat models are routed through `NVIDIA_API_KEY` when the selected model id starts with `nvidia:`.
- The default chat model is `nvidia:mistralai/mistral-medium-3.5-128b`.
- NVIDIA image generation uses `createDocument` with `kind: "image"`.
- NVIDIA image editing uses `createDocument` with `kind: "image"` and `sourceImageUrl`, or `updateDocument` for an existing image artifact.
- Image requests always pass through the NVIDIA safety model first.
- NVIDIA-backed web/deep search uses `NVIDIA_SEARCH_API_URL` when configured. Deep search uses a NVIDIA model to plan focused subqueries before retrieval.

## Required Configuration

- `NVIDIA_API_KEY` is required for NVIDIA-hosted text models and image generation.
- `NVIDIA_SAFETY_MODEL` selects the safety model. If it has no `nvidia:` prefix, the app adds it.
- `NVIDIA_IMAGE_MODEL` selects the image model.
- `NVIDIA_IMAGE_API_URL` can override the text-to-image endpoint.
- `NVIDIA_IMAGE_EDIT_API_URL` can override the image-edit endpoint.
- `NVIDIA_IMAGE_INCLUDE_MODEL=1` includes the model field in the image payload. Keep it unset or `0` if the endpoint rejects extra `model` fields.
- `NVIDIA_IMAGE_WIDTH` and `NVIDIA_IMAGE_HEIGHT` control generated image size.
- `NVIDIA_SEARCH_API_URL` enables NVIDIA-backed web/retrieval search before Tavily or Brave fallbacks.
- `NVIDIA_SEARCH_API_KEY` can provide a separate bearer token for that search endpoint. If omitted, the app uses `NVIDIA_API_KEY`.

## Image Safety Policy

Before any image generation or image editing:

1. Run the normal server-side safety check.
2. Allow fictional or graphic violence when it is not illegal.
3. Block illegal content, including sexual content involving minors, exploitation, non-consensual intimate imagery, doxxing, credential theft, fraud, operational weapons/explosives guidance, evasion of law enforcement, and explicit requests to depict a real person committing an illegal act.
4. If safety is unavailable, fail closed and explain that safety could not complete.

## How To Respond

- For image requests, call the artifact tool instead of explaining how to do it.
- For NVIDIA API errors, identify whether the issue is missing `NVIDIA_API_KEY`, endpoint mismatch, rejected payload fields, unsupported image editing endpoint, or safety failure.
- If the user asks for a current NVIDIA model recommendation or latest NVIDIA API behavior, use the Web Search skill first.
- If the user asks for a real game/movie/person/product visual reference before image generation, use Visual Reference Research first, then this skill.
