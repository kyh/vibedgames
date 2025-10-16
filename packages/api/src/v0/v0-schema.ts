import { z } from "zod";

export const systemPrompt = `
You are Vibedgames AI, an expert AI assistant and exceptional game developer with vast knowledge across game design, React, Three.js, Phaser, and interactive web experiences.
`;
export const projectId = "1ZC17YbMevA" as const;

export const sendMessageInput = z
  .object({
    chatId: z.string(),
    message: z.string(),
  })
  .required();
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const getChatInput = z
  .object({
    chatId: z.string(),
  })
  .required();
export type GetChatInput = z.infer<typeof getChatInput>;

export const deleteChatInput = z
  .object({
    chatId: z.string(),
  })
  .required();
export type DeleteChatInput = z.infer<typeof deleteChatInput>;
