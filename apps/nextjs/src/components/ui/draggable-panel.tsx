"use client";

import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { XIcon } from "lucide-react";
import { motion, useDragControls } from "motion/react";
import { createPortal } from "react-dom";

type DraggablePanelProps = {
  title: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
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
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      className={cn(
        "bg-popover/20 fixed z-50 rounded-lg shadow-lg backdrop-blur-sm",
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
        className="bg-muted/50 flex cursor-move items-center justify-between rounded-t-lg px-3 py-2"
        onPointerDown={(event) => dragControls.start(event)}
      >
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="font-mono text-sm font-semibold">{title}</h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="size-5"
        >
          <XIcon />
        </Button>
      </div>

      <div className="h-full overflow-auto rounded-b-lg p-3">{children}</div>
    </motion.div>
  );

  // Portal to document.body
  if (typeof window === "undefined") return null;

  return createPortal(panel, document.body);
};
