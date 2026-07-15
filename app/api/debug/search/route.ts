import { NextResponse } from "next/server";
import { getAutomaticSearchMode } from "@/lib/search-mode";
import { getWebSearchDebugInfo, searchWeb } from "@/lib/web-search";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const debug = getWebSearchDebugInfo();
  const deployment = {
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    environment: process.env.VERCEL_ENV ?? "local",
  };
  const automaticSearchMode = query ? getAutomaticSearchMode(query) : "off";

  if (!query) {
    return NextResponse.json({
      automaticSearchMode,
      debug,
      deployment,
      message: "Add ?q=your%20query to run a live search test.",
    });
  }

  const search = await searchWeb(query);

  return NextResponse.json({
    automaticSearchMode,
    debug,
    deployment,
    query,
    search: {
      configured: search.configured,
      message: search.message,
      provider: search.provider,
      results: search.results.map((result) => ({
        snippet: result.snippet.slice(0, 240),
        source: result.source,
        title: result.title,
        url: result.url,
      })),
    },
  });
}
