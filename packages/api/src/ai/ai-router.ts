import { v0 } from "v0-sdk";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  createChatInput,
  deleteChatInput,
  getChatInput,
  projectId,
  systemPrompt,
  updateChatInput,
} from "./ai-schema";

export const aiRouter = createTRPCRouter({
  getChats: protectedProcedure.query(async () => {
    const project = await v0.projects.getById({
      projectId,
    });

    return { project, chats: project.chats };
  }),

  getChat: protectedProcedure.input(getChatInput).query(async ({ input }) => {
    const chat = await v0.chats.getById({
      chatId: input.chatId,
    });

    return { chat };
  }),

  deleteChat: protectedProcedure
    .input(deleteChatInput)
    .mutation(async ({ input }) => {
      const chat = await v0.chats.delete({
        chatId: input.chatId,
      });

      return { chat };
    }),

  initChat: protectedProcedure.mutation(async () => {
    const chat = await v0.chats.init({
      type: "files",
      files: [
        {
          name: "example.ts",
          content: "// This is an example of a TypeScript file",
        },
      ],
      projectId: projectId,
    });

    return { chat };
  }),
});
