import { memo } from "react";

type Props = {
  content?: string;
};

export const FileContent = memo(function FileContent({ content }: Props) {
  if (content === undefined) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Select a file to view its contents.
      </div>
    );
  }

  return (
    <pre className="whitespace-pre-wrap break-words p-4 text-xs font-mono">
      {content}
    </pre>
  );
});
