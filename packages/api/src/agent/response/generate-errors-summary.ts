import { generateObject } from "ai";
import { z } from "zod";

import { Models } from "../constants";
import prompt from "./generate-errors-summary-prompt.md";

export const generateErrorsSummary = async (input: { lines: string[] }) => {
  return await generateObject({
    system: prompt,
    model: Models.OpenAIGPT5,
    providerOptions: {
      openai: {
        include: ["reasoning.encrypted_content"],
        reasoningEffort: "minimal",
        reasoningSummary: "auto",
        serviceTier: "priority",
      },
    },
    messages: [{ role: "user", content: JSON.stringify(input) }],
    schema: z.object({
      shouldBeFixed: z.boolean(),
      summary: z.string(),
    }),
  });
};
