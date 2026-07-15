---
name: Visual Reference Research
description: Use before image generation or editing when the user references a real game, film, show, franchise, person, product, venue, artwork, or current visual subject.
---

# Visual Reference Research

Use this skill when the user asks for an image inspired by a real or existing subject, including a game, film, show, franchise, character, place, brand, product, artist, or current event.

Before creating or editing the image artifact:

1. Call `searchWeb` with a targeted query for the referenced subject and visual terms such as "visual style", "setting", "characters", "environment", "costumes", "color palette", or "official".
2. Prefer official pages, reputable encyclopedic summaries, studio/publisher pages, or well-known fan wikis for visual facts.
3. Extract broad visual references only: setting, era, materials, lighting, mood, color palette, genre, silhouette language, environment, props, and composition.
4. Do not copy exact protected characters, logos, poster layouts, screenshots, or trademarked symbols unless the user explicitly asks and it is allowed by safety rules.
5. Rewrite the image prompt as "inspired by" visual traits, not as a direct replica.
6. Continue to use the normal NVIDIA image safety guardrail. Fictional graphic violence can be allowed, but illegal content must be blocked.

If `searchWeb` is not configured or returns no useful result, say that web reference search is unavailable and proceed only with general knowledge if the user still asked for the image.
