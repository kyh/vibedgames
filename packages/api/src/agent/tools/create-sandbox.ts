import type { UIMessage, UIMessageStreamWriter } from "ai";
import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod";

import type { DataPart } from "../messages/data-parts";
import description from "./create-sandbox.md";
import { getRichError } from "./get-rich-error";

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

export const createSandbox = ({ writer }: Params) =>
  tool({
    description,
    inputSchema: z.object({}),
    execute: async (_, { toolCallId }) => {
      writer.write({
        id: toolCallId,
        type: "data-create-sandbox",
        data: { status: "loading" },
      });

      try {
        const sandbox = await Sandbox.create({
          timeout: 600000,
          ports: [3000],
          runtime: "node22",
        });

        writer.write({
          id: toolCallId,
          type: "data-create-sandbox",
          data: { sandboxId: sandbox.sandboxId, status: "done" },
        });

        return (
          `Sandbox created with ID: ${sandbox.sandboxId}.` +
          `\nYou can now upload files, run commands, and access services on the exposed ports.`
        );
      } catch (error) {
        const richError = getRichError({
          action: "Creating Sandbox",
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-create-sandbox",
          data: {
            error: { message: richError.error.message },
            status: "error",
          },
        });

        console.log("Error creating Sandbox:", richError.error);
        return richError.message;
      }
    },
  });
