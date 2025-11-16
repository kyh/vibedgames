"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ScrollArea, ScrollBar } from "@repo/ui/scroll-area";
import { cn } from "@repo/ui/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
} from "lucide-react";

import type { FileNode } from "./build-file-tree";
import { FileContent } from "@/components/file-explorer/file-content";
import { useWorkspaceStore } from "@/components/chat/workspace-store";
import { buildFileTree } from "./build-file-tree";

type Props = {
  className?: string;
  disabled?: boolean;
};

export const FileExplorer = memo(function FileExplorer({
  className,
  disabled,
}: Props) {
  const { paths, files } = useWorkspaceStore((state) => ({
    paths: state.paths,
    files: state.files,
  }));
  const fileTree = useMemo(() => buildFileTree(paths), [paths]);
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [fs, setFs] = useState<FileNode[]>(fileTree);

  useEffect(() => {
    setFs(fileTree);
  }, [fileTree]);

  const toggleFolder = useCallback((path: string) => {
    setFs((prev) => {
      const updateNode = (nodes: FileNode[]): FileNode[] =>
        nodes.map((node) => {
          if (node.path === path && node.type === "folder") {
            return { ...node, expanded: !node.expanded };
          } else if (node.children) {
            return { ...node, children: updateNode(node.children) };
          } else {
            return node;
          }
        });
      return updateNode(prev);
    });
  }, []);

  const selectFile = useCallback((node: FileNode) => {
    if (node.type === "file") {
      setSelected(node);
    }
  }, []);

  const renderFileTree = useCallback(
    (nodes: FileNode[], depth = 0) => {
      return nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={depth}
          selected={selected}
          onToggleFolder={toggleFolder}
          onSelectFile={selectFile}
          renderFileTree={renderFileTree}
        />
      ));
    },
    [selected, toggleFolder, selectFile],
  );

  return (
    <div className={className}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase">
        <FileIcon className="w-4" />
        <span className="font-mono">Workspace Files</span>
        {selected && !disabled && (
          <span className="ml-auto text-gray-500">{selected.path}</span>
        )}
      </div>

      <div className="flex h-[calc(100%-2rem-1px)] text-sm">
        <ScrollArea className="border-primary/18 w-1/4 shrink-0 border-r">
          <div>{renderFileTree(fs)}</div>
        </ScrollArea>
        {selected && !disabled && (
          <ScrollArea className="w-3/4 shrink-0">
            <FileContent
              content={files[selected.path.replace(/^\//, "")]}
            />
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        )}
      </div>
    </div>
  );
});

// Memoized file tree node component
const FileTreeNode = memo(function FileTreeNode({
  node,
  depth,
  selected,
  onToggleFolder,
  onSelectFile,
  renderFileTree,
}: {
  node: FileNode;
  depth: number;
  selected: FileNode | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (node: FileNode) => void;
  renderFileTree: (nodes: FileNode[], depth: number) => React.ReactNode;
}) {
  const handleClick = useCallback(() => {
    if (node.type === "folder") {
      onToggleFolder(node.path);
    } else {
      onSelectFile(node);
    }
  }, [node, onToggleFolder, onSelectFile]);

  return (
    <div>
      <div
        className={cn(
          `flex cursor-pointer items-center px-1 py-0.5 hover:bg-gray-100`,
          { "bg-gray-200/80": selected?.path === node.path },
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {node.type === "folder" ? (
          <>
            {node.expanded ? (
              <ChevronDownIcon className="mr-1 w-4" />
            ) : (
              <ChevronRightIcon className="mr-1 w-4" />
            )}
            <FolderIcon className="mr-2 w-4" />
          </>
        ) : (
          <>
            <div className="mr-1 w-4" />
            <FileIcon className="mr-2 w-4" />
          </>
        )}
        <span className="">{node.name}</span>
      </div>

      {node.type === "folder" && node.expanded && node.children && (
        <div>{renderFileTree(node.children, depth + 1)}</div>
      )}
    </div>
  );
});
