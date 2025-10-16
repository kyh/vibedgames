import { useMutation } from "@tanstack/react-query";

import type { Line } from "./schemas";
import { useTRPC } from "@/trpc/react";
import { resultSchema } from "./schemas";

export function useGetSummary() {
  const trpc = useTRPC();

  return useMutation(
    trpc.agent.errors.mutationOptions({
      onSuccess: (data) => {
        return resultSchema.parse(data);
      },
    }),
  );
}

export function createSummaryMutation(lines: Line[]) {
  // Convert Line objects to strings for the API
  const lineStrings = lines.map(
    (line) =>
      `[${line.stream}] ${line.command} ${line.args.join(" ")}: ${line.data}`,
  );

  return {
    lines: lineStrings,
  };
}
