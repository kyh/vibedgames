import { v0 } from "v0-sdk";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  deleteChatInput,
  getChatInput,
  projectId,
  sendMessageInput,
} from "./v0-schema";

export const v0Router = createTRPCRouter({
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

  sendMessage: protectedProcedure
    .input(sendMessageInput)
    .mutation(async ({ input }) => {
      const chat = await v0.chats.sendMessage({
        chatId: input.chatId,
        message: input.message,
        responseMode: "sync",
      });

      return { chat };
    }),

  getChat: protectedProcedure.input(getChatInput).query(async ({ input }) => {
    const chat = await v0.chats.getById({
      chatId: input.chatId,
    });

    return { chat };
  }),

  getChats: protectedProcedure.query(async () => {
    const project = await v0.projects.getById({
      projectId,
    });

    return { project, chats: project.chats };
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
