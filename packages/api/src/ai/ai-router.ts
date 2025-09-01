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

  createChat: protectedProcedure
    .input(createChatInput)
    .mutation(async ({ input }) => {
      const chat = await v0.chats.create({
        system: systemPrompt,
        message: input.message,
        chatPrivacy: "private",
        projectId: projectId,
        responseMode: "async",
      });

      return { chat };
    }),

  updateChat: protectedProcedure
    .input(updateChatInput)
    .mutation(async ({ input }) => {
      const message = await v0.chats.sendMessage({
        chatId: input.chatId,
        message: input.message,
        responseMode: "async",
      });

      return { message };
    }),

  deleteChat: protectedProcedure
    .input(deleteChatInput)
    .mutation(async ({ input }) => {
      const chat = await v0.chats.delete({
        chatId: input.chatId,
      });

      return { chat };
    }),
});
