"use client";

import type { ReactNode } from "react";
import { cn } from "@repo/ui/utils";
import { XIcon } from "lucide-react";
import { motion, useDragControls } from "motion/react";
import { createPortal } from "react-dom";

type DraggablePanelProps = {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  className?: string;
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
}: DraggablePanelProps) => {
  const dragControls = useDragControls();

  if (!isOpen) return null;

  const panel = (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      className={cn(
        "bg-popover border-border fixed z-50 rounded-lg border shadow-lg",
        className,
      )}
      style={{
        left: initialPosition.x,
        top: initialPosition.y,
        width: initialSize.width,
        height: initialSize.height,
      }}
    >
      <div
        className="border-border bg-muted/50 flex cursor-move items-center justify-between rounded-t-lg border-b px-3 py-2"
        onPointerDown={(event) => dragControls.start(event)}
      >
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="font-mono text-sm font-semibold">{title}</h3>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="h-full overflow-auto p-3">{children}</div>
    </motion.div>
  );

  // Portal to document.body
  if (typeof window === "undefined") return null;

  return createPortal(panel, document.body);
};
