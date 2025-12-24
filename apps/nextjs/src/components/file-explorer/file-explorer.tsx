"use client";

import type { ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@repo/ui/button";
import {
  CodeBlock,
  CodeBlockCopyButton,
  extensionToLanguageMap,
} from "@repo/ui/code-block";
import { ScrollArea } from "@repo/ui/scroll-area";
import { toast } from "@repo/ui/toast";
import { cn } from "@repo/ui/utils";
import { Atom, Braces, Code, FileIcon, FileText, Image } from "lucide-react";

import type { FileNode } from "./build-file-tree";
import { buildFileTree } from "./build-file-tree";

const ROOT_ID = ".";
const INDENT = 20;

// Detect language from file path
const getLanguageFromPath = (path: string): BundledLanguage => {
  const ext = path.split(".").pop()?.toLowerCase();
  return extensionToLanguageMap[ext ?? ""] ?? ("txt" as BundledLanguage);
};

function getFileIcon(
  extension: string | undefined,
  className: string,
): ReactNode {
  switch (extension) {
    case "tsx":
    case "jsx":
      return <Atom className={className} />;
    case "ts":
    case "js":
    case "mjs":
      return <Code className={className} />;
    case "json":
      return <Braces className={className} />;
    case "svg":
    case "ico":
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return <Image className={className} />;
    case "md":
      return <FileText className={className} />;
    default:
      return <FileIcon className={className} />;
  }
}

type Props = {
  className?: string;
  disabled?: boolean;
  files: Record<string, string>;
};

export const FileExplorer = ({ className, disabled, files }: Props) => {
  const { handleMouseDown } = useResizableSidebar();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    new Set([ROOT_ID]),
  );

  const items = useMemo(() => buildFileTree(files), [files]);

  const handleItemClick = (item: FileNode) => {
    if (item.isFolder) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(item.path)) {
          next.delete(item.path);
        } else {
          next.add(item.path);
        }
        return next;
      });
    } else if (!disabled) {
      setSelectedPath(item.path);
    }
  };

  const selectedCode = useMemo(() => {
    if (!selectedPath) return "";
    return (
      files[selectedPath] ??
      files[`/${selectedPath}`] ??
      files[selectedPath.replace(/^\//, "")] ??
      ""
    );
  }, [selectedPath, files]);

  const codeLanguage = useMemo<BundledLanguage>(
    () =>
      selectedPath
        ? getLanguageFromPath(selectedPath)
        : ("plaintext" as BundledLanguage),
    [selectedPath],
  );

  const renderTreeItems = (itemIds: string[], depth = 0): ReactNode => {
    return itemIds.map((itemId) => {
      const item = items[itemId];
      if (!item) return null;

      const isExpanded = expandedPaths.has(item.path);
      const isSelected = selectedPath === item.path;

      return (
        <div key={itemId}>
          <div
            className={cn(
              "hover:bg-accent flex cursor-pointer items-center rounded-none px-2 py-1",
              isSelected && "text-primary bg-accent",
            )}
            style={{ paddingLeft: `${depth * INDENT + 12}px` }}
            onClick={() => handleItemClick(item)}
          >
            <span className="flex items-center gap-2 truncate">
              {!item.isFolder &&
                getFileIcon(
                  item.path.split(".").pop()?.toLowerCase(),
                  "text-muted-foreground pointer-events-none size-4 shrink-0",
                )}
              <span className="truncate">{item.name}</span>
            </span>
          </div>
          {item.isFolder &&
            isExpanded &&
            item.children &&
            item.children.length > 0 && (
              <div>{renderTreeItems(item.children, depth + 1)}</div>
            )}
        </div>
      );
    });
  };

  const rootChildren = items[ROOT_ID]?.children ?? [];

  return (
    <div
      className={cn("bg-background grid h-full", className)}
      style={{ gridTemplateColumns: "var(--sidebar-width, 280px) 1fr" }}
    >
      <div className="relative hidden md:flex">
        <ScrollArea className="flex-1 overflow-auto border-r py-2">
          {renderTreeItems(rootChildren)}
        </ScrollArea>
        <div
          className="hover:bg-primary/50 active:bg-primary/80 absolute top-0 -right-0.5 h-full w-1 cursor-col-resize bg-transparent transition-colors duration-200"
          onMouseDown={handleMouseDown}
        />
      </div>
      <div className="flex overflow-x-auto border-b md:hidden">
        {Object.keys(files).map((path) => (
          <Button
            className={cn("shrink-0", selectedPath === path && "text-primary")}
            variant="ghost"
            size="sm"
            key={path}
            onClick={() => !disabled && setSelectedPath(path)}
          >
            {path}
          </Button>
        ))}
      </div>
      {selectedPath && !disabled && selectedCode && (
        <div className="relative flex-1 overflow-hidden">
          <CodeBlock
            code={selectedCode}
            language={codeLanguage}
            containerClassName="overflow-auto [&>*]:h-full flex-1 h-full"
            preClassName="py-3 px-2 min-h-full"
          />
          <CodeBlockCopyButton
            code={selectedCode}
            className="absolute top-2 right-3"
            onCopy={() => {
              toast.success("Copied to clipboard");
            }}
          />
        </div>
      )}
    </div>
  );
};

type UseResizableSidebarOptions = {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
};

export const useResizableSidebar = ({
  defaultWidth = 240,
  minWidth = 100,
  maxWidth = 300,
}: UseResizableSidebarOptions = {}) => {
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);
  const isResizingRef = useRef<boolean>(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    // Get current width from CSS variable
    const currentWidth = parseInt(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--sidebar-width")
        .replace("px", "") || defaultWidth.toString(),
    );
    startWidthRef.current = currentWidth;
  };

  useEffect(() => {
    // Set initial CSS variable value
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${defaultWidth}px`,
    );

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;

      const deltaX = e.clientX - startXRef.current;
      const newWidth = startWidthRef.current + deltaX;
      const clampedWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);

      // Set CSS variable directly
      document.documentElement.style.setProperty(
        "--sidebar-width",
        `${clampedWidth}px`,
      );
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    const handleMouseDownGlobal = () => {
      if (isResizingRef.current) {
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }
    };

    // Add event listeners
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDownGlobal);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDownGlobal);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [defaultWidth, minWidth, maxWidth]);

  return {
    handleMouseDown,
  };
};
