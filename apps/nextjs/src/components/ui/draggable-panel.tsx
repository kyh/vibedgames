"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { XIcon } from "lucide-react";
import { motion } from "motion/react";
import { createPortal } from "react-dom";

import { useLocalStorage } from "@/lib/use-localstorage";

type DraggablePanelProps = {
  title: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  className?: string;
  minWidth?: number;
  minHeight?: number;
  storageKey?: string;
};

type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

type PanelState = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

export const DraggablePanel = ({
  title,
  icon,
  children,
  isOpen,
  onClose,
  initialPosition = { x: 20, y: 20 },
  initialSize = { width: 300, height: 200 },
  className,
  minWidth = 200,
  minHeight = 150,
  storageKey,
}: DraggablePanelProps) => {
  // Generate storage key from title if not provided
  const panelKey =
    storageKey ??
    `draggable-panel-${typeof title === "string" ? title.toLowerCase().replace(/\s+/g, "-") : "default"}`;

  const [panelState, setPanelState] = useLocalStorage<PanelState>(
    `${panelKey}-state`,
    {
      position: initialPosition,
      size: initialSize,
    },
  );

  // Use stored values directly
  const position = panelState.position;
  const size = panelState.size;

  const [isResizing, setIsResizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    top: number;
  } | null>(null);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const handleResizeStart = useCallback(
    (handle: ResizeHandle, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);

      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      if (panelRef.current) {
        const rect = panelRef.current.getBoundingClientRect();
        resizeStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top,
        };
      }

      const handleMove = (moveEvent: PointerEvent) => {
        if (!resizeStartRef.current) return;
        // Only process events for the captured pointer
        if (moveEvent.pointerId !== e.pointerId) return;

        const deltaX = moveEvent.clientX - resizeStartRef.current.x;
        const deltaY = moveEvent.clientY - resizeStartRef.current.y;

        let newWidth = resizeStartRef.current.width;
        let newHeight = resizeStartRef.current.height;
        let newLeft = resizeStartRef.current.left;
        let newTop = resizeStartRef.current.top;

        // Handle corner and edge resizing
        if (handle === "se" || handle === "e" || handle === "ne") {
          newWidth = Math.max(minWidth, resizeStartRef.current.width + deltaX);
        }
        if (handle === "se" || handle === "s" || handle === "sw") {
          newHeight = Math.max(
            minHeight,
            resizeStartRef.current.height + deltaY,
          );
        }
        if (handle === "sw" || handle === "w" || handle === "nw") {
          newWidth = Math.max(minWidth, resizeStartRef.current.width - deltaX);
          newLeft = resizeStartRef.current.left + deltaX;
        }
        if (handle === "ne" || handle === "n" || handle === "nw") {
          newHeight = Math.max(
            minHeight,
            resizeStartRef.current.height - deltaY,
          );
          newTop = resizeStartRef.current.top + deltaY;
        }

        // Constrain to viewport
        const maxWidth = window.innerWidth - newLeft;
        const maxHeight = window.innerHeight - newTop;
        newWidth = Math.min(newWidth, maxWidth);
        newHeight = Math.min(newHeight, maxHeight);

        // Ensure minimum position
        if (newLeft < 0) {
          newWidth += newLeft;
          newLeft = 0;
        }
        if (newTop < 0) {
          newHeight += newTop;
          newTop = 0;
        }

        setPanelState({
          position: { x: newLeft, y: newTop },
          size: { width: newWidth, height: newHeight },
        });
      };

      const handleEnd = (endEvent?: PointerEvent) => {
        if (endEvent && endEvent.pointerId !== e.pointerId) return;

        setIsResizing(false);
        resizeStartRef.current = null;
        target.releasePointerCapture(e.pointerId);
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleEnd);
        document.removeEventListener("pointercancel", handleEnd);
      };

      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleEnd);
      document.addEventListener("pointercancel", handleEnd);
    },
    [minWidth, minHeight, setPanelState],
  );

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);

      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      if (panelRef.current) {
        const rect = panelRef.current.getBoundingClientRect();
        dragStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          left: rect.left,
          top: rect.top,
        };
      }

      const handleMove = (moveEvent: PointerEvent) => {
        if (!dragStartRef.current) return;
        // Only process events for the captured pointer
        if (moveEvent.pointerId !== e.pointerId) return;

        const deltaX = moveEvent.clientX - dragStartRef.current.x;
        const deltaY = moveEvent.clientY - dragStartRef.current.y;

        let newLeft = dragStartRef.current.left + deltaX;
        let newTop = dragStartRef.current.top + deltaY;

        // Constrain to viewport
        const maxLeft = window.innerWidth - size.width;
        const maxTop = window.innerHeight - size.height;
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        setPanelState((prev) => ({
          position: { x: newLeft, y: newTop },
          size: prev?.size ?? size,
        }));
      };

      const handleEnd = (endEvent?: PointerEvent) => {
        if (endEvent && endEvent.pointerId !== e.pointerId) return;

        setIsDragging(false);
        dragStartRef.current = null;
        target.releasePointerCapture(e.pointerId);
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleEnd);
        document.removeEventListener("pointercancel", handleEnd);
      };

      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleEnd);
      document.addEventListener("pointercancel", handleEnd);
    },
    [size, setPanelState],
  );

  const ResizeHandle = ({
    handle,
    className: handleClassName,
  }: {
    handle: ResizeHandle;
    className?: string;
  }) => {
    const isCorner =
      handle === "nw" || handle === "ne" || handle === "sw" || handle === "se";
    const cornerSize = 12;

    return (
      <div
        className={cn(
          "absolute bg-transparent",
          handle === "nw" && "top-0 left-0 cursor-nw-resize",
          handle === "ne" && "top-0 right-0 cursor-ne-resize",
          handle === "sw" && "bottom-0 left-0 cursor-sw-resize",
          handle === "se" && "right-0 bottom-0 cursor-se-resize",
          handle === "n" && "top-0 right-0 left-0 cursor-n-resize",
          handle === "s" && "right-0 bottom-0 left-0 cursor-s-resize",
          handle === "e" && "top-0 right-0 bottom-0 cursor-e-resize",
          handle === "w" && "top-0 bottom-0 left-0 cursor-w-resize",
          handleClassName,
        )}
        style={{
          width: isCorner
            ? `${cornerSize}px`
            : handle === "n" || handle === "s"
              ? "100%"
              : "8px",
          height: isCorner
            ? `${cornerSize}px`
            : handle === "e" || handle === "w"
              ? "100%"
              : "8px",
          zIndex: isCorner ? 20 : 10,
        }}
        onPointerDown={(e) => handleResizeStart(handle, e)}
      />
    );
  };

  if (!isOpen) return null;

  const panel = (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn(
        "bg-popover/20 fixed z-50 flex flex-col rounded-lg shadow-lg backdrop-blur-sm",
        (isResizing || isDragging) && "select-none",
        className,
      )}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
      }}
    >
      <div
        className="bg-muted/50 flex cursor-move items-center justify-between rounded-t-lg px-3 py-2"
        onPointerDown={handleDragStart}
      >
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="font-mono text-sm font-semibold">{title}</h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          className="size-5"
        >
          <XIcon />
        </Button>
      </div>

      <div className="flex-1 overflow-auto rounded-b-lg">{children}</div>

      {/* Resize handles */}
      <ResizeHandle handle="nw" />
      <ResizeHandle handle="ne" />
      <ResizeHandle handle="sw" />
      <ResizeHandle handle="se" />
      <ResizeHandle handle="n" />
      <ResizeHandle handle="s" />
      <ResizeHandle handle="e" />
      <ResizeHandle handle="w" />
    </motion.div>
  );

  // Portal to document.body
  if (typeof window === "undefined") return null;

  return createPortal(panel, document.body);
};
