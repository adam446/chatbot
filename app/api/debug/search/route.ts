import { NextResponse } from "next/server";
import { getWebSearchDebugInfo, searchWeb } from "@/lib/web-search";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const debug = getWebSearchDebugInfo();

  if (!query) {
    return NextResponse.json({
      debug,
      message: "Add ?q=your%20query to run a live search test.",
    });
  }

  const search = await searchWeb(query);

  return NextResponse.json({
    debug,
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
