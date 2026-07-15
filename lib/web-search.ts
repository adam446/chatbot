import { z } from "zod";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

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

function cleanResults(results: WebSearchResult[]) {
  return results
    .filter((result) => result.title && result.url)
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

export async function searchWeb(query: string) {
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
