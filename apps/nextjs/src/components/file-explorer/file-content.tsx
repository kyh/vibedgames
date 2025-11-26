"use client";

import { useSandpackStore } from "@/components/sandpack/sandpack-store";

type Props = {
  path: string;
};

export const FileContent = ({ path }: Props) => {
  const files = useSandpackStore((state) => state.files);

  // Normalize the path to match sandpack format (starts with /)
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const file = files[normalizedPath];

  if (!file) {
    return (
      <pre className="p-2 text-gray-400">
        <code>File not found: {path}</code>
      </pre>
    );
  }

  return (
    <pre className="p-2">
      <code>{file.code}</code>
    </pre>
  );
};
