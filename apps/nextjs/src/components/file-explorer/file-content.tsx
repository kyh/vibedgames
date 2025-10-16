import { memo } from "react";
import { Spinner } from "@repo/ui/spinner";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "@/trpc/react";
import { SyntaxHighlighter } from "./syntax-highlighter";

type Props = {
  sandboxId: string;
  path: string;
};

export const FileContent = memo(function FileContent({
  sandboxId,
  path,
}: Props) {
  const trpc = useTRPC();

  const { data: content, isLoading } = useQuery({
    ...trpc.sandbox.getFile.queryOptions({
      sandboxId,
      path,
    }),
    refetchInterval: 1000,
  });

  if (isLoading || !content) {
    return (
      <div className="absolute flex h-full w-full items-center text-center">
        <div className="flex-1">
          <Spinner />
        </div>
      </div>
    );
  }

  return <SyntaxHighlighter path={path} code={content} />;
});
