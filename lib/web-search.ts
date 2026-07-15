import { generateText } from "ai";
import { z } from "zod";
import { getLanguageModel } from "./ai/providers";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

type WebSearchResponse = {
  configured: boolean;
  message?: string;
  provider: string | null;
  results: WebSearchResult[];
};

export function getWebSearchDebugInfo() {
  const configuredProviders = [
    process.env.NVIDIA_SEARCH_API_URL ? "nvidia" : null,
    process.env.TAVILY_API_KEY ? "tavily" : null,
    process.env.BRAVE_SEARCH_API_KEY ? "brave" : null,
  ].filter((provider): provider is string => Boolean(provider));

  return {
    configuredProviders,
    hasBraveSearchApiKey: Boolean(process.env.BRAVE_SEARCH_API_KEY),
    hasNvidiaApiKey: Boolean(process.env.NVIDIA_API_KEY),
    hasNvidiaSearchApiKey: Boolean(process.env.NVIDIA_SEARCH_API_KEY),
    hasNvidiaSearchApiUrl: Boolean(process.env.NVIDIA_SEARCH_API_URL),
    hasTavilyApiKey: Boolean(process.env.TAVILY_API_KEY),
    searchConfigured: configuredProviders.length > 0,
  };
}

const tavilyResultSchema = z.object({
  content: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
});

const tavilyResponseSchema = z.object({
  results: z.array(tavilyResultSchema).optional(),
});

const braveResultSchema = z.object({
  description: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
});

const braveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(braveResultSchema).optional(),
    })
    .optional(),
});

const flexibleSearchResultSchema = z.object({
  content: z.string().optional(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
});

const flexibleSearchResponseSchema = z.object({
  answer: z.string().optional(),
  results: z.array(flexibleSearchResultSchema).optional(),
  sources: z.array(flexibleSearchResultSchema).optional(),
});

function getSearchResultScore(result: WebSearchResult) {
  let score = 0;
  const combined =
    `${result.title} ${result.url} ${result.snippet}`.toLowerCase();

  try {
    const hostname = new URL(result.url).hostname.toLowerCase();
    if (
      hostname.endsWith(".gc.ca") ||
      hostname.endsWith(".gov") ||
      hostname.includes(".gov.") ||
      hostname.includes("canada.ca") ||
      hostname.includes("pm.gc.ca")
    ) {
      score += 100;
    }
    if (
      hostname.includes("wikipedia.org") ||
      hostname.includes("facebook.com") ||
      hostname.includes("x.com") ||
      hostname.includes("twitter.com")
    ) {
      score -= 30;
    }
  } catch {
    score -= 5;
  }

  if (
    /\b(current|official|actuel|actuelle|prime minister|premier ministre)\b/.test(
      combined
    )
  ) {
    score += 10;
  }

  return score;
}

export function rankSearchResultsForAnswer(results: WebSearchResult[]) {
  return [...results].sort(
    (a, b) => getSearchResultScore(b) - getSearchResultScore(a)
  );
}

function getOfficialSource(result: WebSearchResult) {
  try {
    const hostname = new URL(result.url).hostname.toLowerCase();
    return (
      hostname.endsWith(".gc.ca") ||
      hostname.endsWith(".gov") ||
      hostname.includes(".gov.") ||
      hostname.includes("canada.ca") ||
      hostname.includes("pm.gc.ca")
    );
  } catch {
    return false;
  }
}

function extractCanadaPrimeMinisterName(text: string) {
  return (
    text.match(
      /The Right Honourable\s+([A-Z][A-Za-zÀ-ÿ'’-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’-]+){1,3}),\s+Prime Minister of Canada/i
    )?.[1] ??
    text.match(
      /([A-Z][A-Za-zÀ-ÿ'’-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’-]+){1,3})\s+is\s+Canada[’']s\s+(?:\d+(?:st|nd|rd|th)\s+)?Prime Minister/i
    )?.[1] ??
    null
  );
}

export function buildVerifiedSearchAnswer({
  query,
  results,
}: {
  query: string;
  results: WebSearchResult[];
}) {
  const normalizedQuery = query.toLowerCase();
  const asksCanadaPrimeMinister =
    /\b(canada|canadien|canadienne)\b/.test(normalizedQuery) &&
    /\b(prime minister|premier ministre)\b/.test(normalizedQuery);

  if (!asksCanadaPrimeMinister) {
    return null;
  }

  const officialResult = results.find(getOfficialSource);
  if (!officialResult) {
    return null;
  }

  const name = extractCanadaPrimeMinisterName(
    `${officialResult.title} ${officialResult.snippet}`
  );
  if (!name) {
    return null;
  }

  return [
    `Verified answer from the highest-priority official source: ${name} is the current Prime Minister of Canada.`,
    `Answer in the user's language and cite this source: ${officialResult.title} (${officialResult.url}).`,
    "",
    `Réponse de secours si le modèle ne génère aucun texte: Le premier ministre actuel du Canada est **${name}**.`,
    `Source: [${officialResult.title}](${officialResult.url})`,
  ].join("\n");
}

function cleanResults(results: WebSearchResult[]) {
  return rankSearchResultsForAnswer(
    results.filter((result) => result.title && result.url)
  )
    .slice(0, 5)
    .map((result) => ({
      snippet: result.snippet.slice(0, 700),
      source: result.source,
      title: result.title.slice(0, 200),
      url: result.url,
    }));
}

async function searchTavily(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return [];
  }

  const response = await fetch("https://api.tavily.com/search", {
    body: JSON.stringify({
      api_key: apiKey,
      include_answer: false,
      max_results: 5,
      query,
      search_depth: "basic",
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed (${response.status})`);
  }

  const json = tavilyResponseSchema.parse(await response.json());
  return cleanResults(
    (json.results ?? []).map((result) => ({
      snippet: result.content ?? "",
      source: "tavily",
      title: result.title ?? "",
      url: result.url ?? "",
    }))
  );
}

async function searchBrave(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return [];
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("count", "5");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave search failed (${response.status})`);
  }

  const json = braveResponseSchema.parse(await response.json());
  return cleanResults(
    (json.web?.results ?? []).map((result) => ({
      snippet: result.description ?? "",
      source: "brave",
      title: result.title ?? "",
      url: result.url ?? "",
    }))
  );
}

async function searchNvidia(query: string): Promise<WebSearchResult[]> {
  const endpoint = process.env.NVIDIA_SEARCH_API_URL;
  if (!endpoint) {
    return [];
  }

  const apiKey =
    process.env.NVIDIA_SEARCH_API_KEY ?? process.env.NVIDIA_API_KEY;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    body: JSON.stringify({
      max_results: 5,
      query,
    }),
    headers,
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`NVIDIA search failed (${response.status})`);
  }

  const json = flexibleSearchResponseSchema.parse(await response.json());
  const results = cleanResults(
    [...(json.results ?? []), ...(json.sources ?? [])].map((result) => ({
      snippet:
        result.snippet ??
        result.content ??
        result.description ??
        result.text ??
        "",
      source: "nvidia",
      title: result.title ?? result.url ?? "NVIDIA search result",
      url: result.url ?? "",
    }))
  );

  if (results.length > 0) {
    return results;
  }

  if (json.answer) {
    return [
      {
        snippet: json.answer.slice(0, 700),
        source: "nvidia",
        title: "NVIDIA search answer",
        url: endpoint,
      },
    ];
  }

  return [];
}

const deepSearchPlanSchema = z.object({
  queries: z.array(z.string().min(2).max(300)).min(1).max(5),
});

function parseJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  return JSON.parse(candidate);
}

function uniqueResults(results: WebSearchResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url || `${result.title}:${result.snippet}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function planDeepSearchQueries(query: string) {
  if (!process.env.NVIDIA_API_KEY) {
    return [query];
  }

  try {
    const { text } = await generateText({
      model: getLanguageModel("nvidia:nvidia/nemotron-3-ultra-550b-a55b"),
      prompt: `Create 3 to 5 focused web/retrieval search queries for this research question.
Return only JSON in this exact shape: {"queries":["..."]}.
Question: ${query}`,
    });
    const parsed = deepSearchPlanSchema.parse(parseJsonObject(text));
    return Array.from(new Set([query, ...parsed.queries])).slice(0, 5);
  } catch {
    return [query];
  }
}

function buildDeepSearchSummary({
  query,
  plannedQueries,
  provider,
  results,
}: {
  query: string;
  plannedQueries: string[];
  provider: string | null;
  results: WebSearchResult[];
}) {
  const sourceLines = results
    .map(
      (result, index) =>
        `${index + 1}. ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`
    )
    .join("\n\n");

  return [
    `Deep search completed for: ${query}`,
    `Provider: ${provider ?? "unknown"}`,
    `Queries used: ${plannedQueries.join(" | ")}`,
    "",
    "Sources found:",
    sourceLines || "No sources found.",
  ].join("\n");
}

export async function searchWeb(query: string): Promise<WebSearchResponse> {
  const errors: string[] = [];

  if (process.env.NVIDIA_SEARCH_API_URL) {
    try {
      const results = await searchNvidia(query);
      return { configured: true, provider: "nvidia", results };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "NVIDIA failed");
    }
  }

  if (process.env.TAVILY_API_KEY) {
    try {
      const results = await searchTavily(query);
      return { configured: true, provider: "tavily", results };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Tavily failed");
    }
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const results = await searchBrave(query);
      return { configured: true, provider: "brave", results };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Brave failed");
    }
  }

  if (errors.length > 0) {
    return {
      configured: true,
      message: `Web search failed: ${errors.join("; ")}`,
      provider: null,
      results: [],
    };
  }

  return {
    configured: false,
    message:
      "Web search is not configured. Set NVIDIA_SEARCH_API_URL for NVIDIA-backed search, or TAVILY_API_KEY / BRAVE_SEARCH_API_KEY for external search.",
    provider: null,
    results: [],
  };
}

export async function deepSearch(query: string) {
  const plannedQueries = await planDeepSearchQueries(query);
  const searches = await Promise.all(plannedQueries.map((q) => searchWeb(q)));
  const configured = searches.some((search) => search.configured);
  const provider = searches.find((search) => search.provider)?.provider ?? null;
  const results = rankSearchResultsForAnswer(
    uniqueResults(searches.flatMap((search) => search.results))
  );
  const messages = searches
    .map((search) => search.message)
    .filter((message): message is string => Boolean(message));

  if (!configured) {
    return {
      configured: false,
      message:
        messages[0] ??
        "Deep search is not configured. Set NVIDIA_SEARCH_API_URL for NVIDIA-backed search.",
      plannedQueries,
      provider: null,
      results: [],
      summary: "",
    };
  }

  return {
    configured: true,
    message: messages[0],
    plannedQueries,
    provider,
    results,
    summary: buildDeepSearchSummary({
      plannedQueries,
      provider,
      query,
      results,
    }),
  };
}
