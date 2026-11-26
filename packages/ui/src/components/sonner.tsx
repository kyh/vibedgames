"use client";

import { Toaster as Sonner } from "sonner";
import type { ToasterProps } from "sonner";
import "@repo/ui/lib/css-variables";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

export const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner
    theme="system"
    className="toaster group"
    icons={{
      error: <OctagonXIcon className="size-4" />,
      info: <InfoIcon className="size-4" />,
      loading: <Loader2Icon className="size-4 animate-spin" />,
      success: <CircleCheckIcon className="size-4" />,
      warning: <TriangleAlertIcon className="size-4" />,
    }}
    style={{
      "--border-radius": "var(--radius)",
      "--normal-bg": "var(--popover)",
      "--normal-border": "var(--border)",
      "--normal-text": "var(--popover-foreground)",
    }}
    toastOptions={{
      classNames: {
        toast: "cn-toast",
      },
    }}
    {...props}
  />
);

export { toast } from "sonner";
