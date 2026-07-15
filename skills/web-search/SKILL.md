---
name: Web Search
description: Use when the user asks to search online, verify current facts, look up recent information, or answer questions that may have changed over time.
---

# Web Search

Use this skill whenever the user asks you to search, verify, look up, check online, or answer a question whose answer may have changed recently.

Examples include current leaders, prices, product availability, news, schedules, laws, model releases, sports results, company executives, and any request that says "search", "deep search", "recherche", "cherche en ligne", or "fais une recherche".

Before answering:

1. Call `searchWeb` with a focused query.
2. For deep search, call `searchWeb` multiple times with different focused queries.
3. Use the search results as the basis for the answer.
4. Include source links when useful.
5. Prefer NVIDIA-backed search when configured through `NVIDIA_SEARCH_API_URL`.
6. If `searchWeb` says search is not configured, say that web search needs `NVIDIA_SEARCH_API_URL` for NVIDIA-backed search, or `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` for fallback external search. Do not pretend you searched.
7. If search results conflict, explain the uncertainty and prefer official or primary sources.
