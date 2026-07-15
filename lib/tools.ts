import { tool } from "ai";
import { z } from "zod";
import { findRelevantChunks } from "./rag";
import { getSkillByName, skills } from "./system-prompt";
import { searchWeb } from "./web-search";

// TODO: implement real API calls using createApiClient

export function createTools(_token: string) {
  return {
    getItemById: tool({
      description: "Fetches a single item by its ID from the API.",
      execute: async ({ id: _id }) => ({ item: null }),
      inputSchema: z.object({
        id: z.string().describe("The unique identifier of the item to fetch."),
      }),
    }),

    getItems: tool({
      description: "Fetches a list of items from the API.",
      execute: async () => ({ items: [] }),
      inputSchema: z.object({}),
    }),

    getSkillDetails: tool({
      description:
        "Load the full instructions for a skill by its name. Call this before responding whenever a skill is relevant to the user's request.",
      execute: ({ name }) => {
        const skill = getSkillByName(name);
        if (!skill) {
          return { error: `Skill "${name}" not found.` };
        }
        return { instructions: skill.body, name: skill.name };
      },
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            `The name of the skill to load. Available names: ${skills.map((s) => s.name).join(", ")}`
          ),
      }),
    }),
    searchDocuments: tool({
      description:
        "Search through uploaded documents to find relevant information. Use this whenever the user asks about something that might be in their files.",
      execute: async ({ query }) => {
        const results = await findRelevantChunks(query);

        if (results.length === 0) {
          return {
            found: false,
            message: "No relevant documents found for that query.",
          };
        }

        return {
          found: true,
          results: results.map((result) => ({
            content: result.content,
            fileName: result.fileName,
            similarity: result.similarity,
          })),
        };
      },
      inputSchema: z.object({
        query: z
          .string()
          .describe("The question or topic to search for in the documents."),
      }),
    }),

    searchWeb: tool({
      description:
        "Search the public web for current or real-world reference information. Use this before image generation when the user references a real game, film, show, franchise, person, product, place, or visual subject.",
      execute: async ({ query }) => searchWeb(query),
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .max(300)
          .describe("A focused web search query."),
      }),
    }),

    submitAction: tool({
      description: "Submits an action or data payload to the API.",
      execute: async () => ({ success: true }),
      inputSchema: z.object({
        action: z.string().describe("The action to submit."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional payload data."),
      }),
    }),
  };
}
