import { createTRPCRouter, publicProcedure } from "../trpc";
import { errorRequestSchema, errorResponseSchema } from "./agent-schema";
import { SUPPORTED_MODELS } from "./constants";
import { getAvailableModels } from "./gateway";
import { generateErrorsSummary } from "./response/generate-errors-summary";

export const agentRouter = createTRPCRouter({
  errors: publicProcedure
    .input(errorRequestSchema)
    .output(errorResponseSchema)
    .mutation(async ({ input }) => {
      const result = await generateErrorsSummary(input);
      return result.object;
    }),

  models: publicProcedure.query(async () => {
    const allModels = await getAvailableModels();
    return {
      models: allModels.filter((model) => SUPPORTED_MODELS.includes(model.id)),
    };
  }),
});
