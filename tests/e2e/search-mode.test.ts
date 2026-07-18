import { expect, test } from "@playwright/test";
import { postRequestBodySchema } from "@/app/(chat)/api/chat/schema";
import { getAutomaticSearchMode } from "@/lib/search-mode";
import { deepSearch, rankSearchResultsForAnswer } from "@/lib/web-search";

test.describe("Search mode detection", () => {
  test("detects freshness-sensitive prompts", () => {
    expect(
      getAutomaticSearchMode("qui est le premier ministre du Canada?")
    ).toBe("search");
    expect(getAutomaticSearchMode("who is the prime minister of Canada?")).toBe(
      "search"
    );
    expect(
      getAutomaticSearchMode("verifie qui est le premier ministre du Canada")
    ).toBe("search");
    expect(getAutomaticSearchMode("deep search prime minister Canada")).toBe(
      "deep"
    );
    expect(getAutomaticSearchMode("explique le routing dans Next.js")).toBe(
      "off"
    );
  });

  test("debug route reports automatic search mode", async ({ request }) => {
    const response = await request.get(
      "/api/debug/search?q=qui%20est%20le%20premier%20ministre%20du%20Canada"
    );

    expect(response.ok()).toBe(true);
    await expect(await response.json()).toEqual(
      expect.objectContaining({
        automaticSearchMode: "search",
      })
    );
  });

  test("chat schema accepts explicit search modes", () => {
    const baseBody = {
      id: "00000000-0000-4000-8000-000000000000",
      message: {
        id: "00000000-0000-4000-8000-000000000001",
        parts: [
          { text: "qui est le premier ministre du Canada?", type: "text" },
        ],
        role: "user",
      },
      selectedChatModel: "nvidia:mistralai/mistral-medium-3.5-128b",
      selectedVisibilityType: "private",
    };

    expect(
      postRequestBodySchema.parse({ ...baseBody, searchMode: "search" })
        .searchMode
    ).toBe("search");
    expect(
      postRequestBodySchema.parse({ ...baseBody, searchMode: "deep" })
        .searchMode
    ).toBe("deep");
  });

  test("ranks official sources before older secondary sources", () => {
    const ranked = rankSearchResultsForAnswer([
      {
        snippet: "Justin Trudeau served as prime minister from 2015 to 2025.",
        title: "Justin Trudeau",
        url: "https://en.wikipedia.org/wiki/Justin_Trudeau",
      },
      {
        snippet: "Mark Carney is Canada's 24th Prime Minister.",
        title: "About | Prime Minister of Canada",
        url: "https://www.pm.gc.ca/en/about",
      },
    ]);

    expect(ranked[0].url).toBe("https://www.pm.gc.ca/en/about");
  });

  test("deep search keeps multiple angles when providers are unavailable", async () => {
    const envNames = [
      "NVIDIA_API_KEY",
      "NVIDIA_SEARCH_API_URL",
      "NVIDIA_SEARCH_API_KEY",
      "TAVILY_API_KEY",
      "BRAVE_SEARCH_API_KEY",
    ] as const;
    const previous = new Map(envNames.map((name) => [name, process.env[name]]));

    try {
      for (const name of envNames) {
        delete process.env[name];
      }

      const result = await deepSearch("test research question");
      expect(result.configured).toBe(false);
      expect(result.plannedQueries.length).toBeGreaterThanOrEqual(5);
      expect(result.report).toBeNull();
    } finally {
      for (const name of envNames) {
        const value = previous.get(name);
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

test.describe("Search mode controls", () => {
  test("sends search mode in chat request body", async ({ page }) => {
    let body: Record<string, unknown> | undefined;

    await page.route("**/api/chat", async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ body: "", status: 200 });
    });

    await page.goto("/");
    await page.getByTestId("search-mode-button").click();
    await page.getByTestId("multimodal-input").fill("qui est le PM?");
    await page.getByTestId("send-button").click();

    await expect.poll(() => body?.searchMode).toBe("search");
  });

  test("sends deep search mode in chat request body", async ({ page }) => {
    let body: Record<string, unknown> | undefined;

    await page.route("**/api/chat", async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ body: "", status: 200 });
    });

    await page.goto("/");
    await page.getByTestId("deep-search-mode-button").click();
    await page.getByTestId("multimodal-input").fill("prime minister Canada");
    await page.getByTestId("send-button").click();

    await expect.poll(() => body?.searchMode).toBe("deep");
  });
});
