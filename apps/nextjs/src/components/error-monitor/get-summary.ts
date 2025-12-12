import { useMutation } from "@tanstack/react-query";

import type { Line } from "./schemas";
import { resultSchema } from "./schemas";

/**
 * Stub for error summary - command execution has been removed,
 * so there are no command logs to analyze for errors.
 * This hook is kept for API compatibility but always returns a resolved promise.
 */
export function useGetSummary() {
  return useMutation({
    mutationFn: async (_input: { lines: string[] }) => {
      // Always return that errors should not be fixed since we no longer have command logs
      return resultSchema.parse({
        shouldBeFixed: false,
        summary: "",
      });
    },
  });
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
