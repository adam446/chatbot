import { tool } from "ai";
import { z } from "zod";
import { skills, getSkillByName } from "./system-prompt";
import { findRelevantChunks } from "./rag";

// TODO: implement real API calls using createApiClient

export function createTools(_token: string) {
  return {
    searchDocuments: tool({
      description:
        "Search through uploaded documents to find relevant information. Use this whenever the user asks about something that might be in their files.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The question or topic to search for in the documents."),
      }),
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
    }),

    getSkillDetails: tool({
      description:
        "Load the full instructions for a skill by its name. Call this before responding whenever a skill is relevant to the user's request.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            `The name of the skill to load. Available names: ${skills.map((s) => s.name).join(", ")}`
          ),
      }),
      execute: async ({ name }) => {
        const skill = getSkillByName(name);
        if (!skill) return { error: `Skill "${name}" not found.` };
        return { name: skill.name, instructions: skill.body };
      },
    }),

    getItems: tool({
      description: "Fetches a list of items from the API.",
      inputSchema: z.object({}),
      execute: async () => ({ items: [] }),
    }),

    getItemById: tool({
      description: "Fetches a single item by its ID from the API.",
      inputSchema: z.object({
        id: z.string().describe("The unique identifier of the item to fetch."),
      }),
      execute: async ({ id: _id }) => ({ item: null }),
    }),

    submitAction: tool({
      description: "Submits an action or data payload to the API.",
      inputSchema: z.object({
        action: z.string().describe("The action to submit."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional payload data."),
      }),
      execute: async () => ({ success: true }),
    }),
  };
}
