import type { UIMessage, UIMessageStreamWriter } from "ai";
import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod/v3";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { getRichError } from "@repo/api/game/local/agent/tools/get-rich-error";

const description = `Retrieve the public URL for a service running inside the Vercel Sandbox.

Use this tool after starting a dev server or any HTTP service inside the sandbox to get a publicly accessible URL. The URL allows the user to preview the running application in their browser.

IMPORTANT:
- The port must match the port where your service is listening (typically 3000)
- The service must be running before calling this tool
- The URL is temporary and tied to the sandbox lifetime`;

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

export const getSandboxURL = ({ writer }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z
        .string()
        .describe("The unique identifier of the Vercel Sandbox"),
      port: z
        .number()
        .describe(
          "The port number where a service is running inside the sandbox (e.g., 3000)",
        ),
    }),
    execute: async ({ sandboxId, port }, { toolCallId }) => {
      writer.write({
        id: toolCallId,
        type: "data-get-sandbox-url",
        data: { status: "loading" },
      });

      try {
        const sandbox = await Sandbox.get({ sandboxId });
        const url = sandbox.domain(port);

        writer.write({
          id: toolCallId,
          type: "data-get-sandbox-url",
          data: { url, status: "done" },
        });

        return { url };
      } catch (error) {
        const richError = getRichError({
          action: "get sandbox url",
          args: { sandboxId, port },
          error,
        });

        console.error("Failed to obtain sandbox URL:", richError.error);

        writer.write({
          id: toolCallId,
          type: "data-get-sandbox-url",
          data: { status: "done" },
        });

        return richError.message;
      }
    },
  });
