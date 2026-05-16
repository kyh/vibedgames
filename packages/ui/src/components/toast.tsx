"use client";

import { Toast } from "@base-ui/react/toast";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { cn } from "@repo/ui/lib/utils";

type ToastType =
  | "default"
  | "success"
  | "info"
  | "warning"
  | "error"
  | "loading";

type ToastOptions = {
  id?: string;
  description?: React.ReactNode;
  timeout?: number;
  priority?: "low" | "high";
  actionProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  onClose?: () => void;
};

type ToasterPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

const toaster = Toast.createToastManager();

const add = (
  type: ToastType,
  title: React.ReactNode,
  options?: ToastOptions,
) => toaster.add({ ...options, type, title });

export const toast = Object.assign(
  (title: React.ReactNode, options?: ToastOptions) =>
    add("default", title, options),
  {
    success: (title: React.ReactNode, options?: ToastOptions) =>
      add("success", title, options),
    info: (title: React.ReactNode, options?: ToastOptions) =>
      add("info", title, options),
    warning: (title: React.ReactNode, options?: ToastOptions) =>
      add("warning", title, options),
    error: (title: React.ReactNode, options?: ToastOptions) =>
      add("error", title, options),
    loading: (title: React.ReactNode, options?: ToastOptions) =>
      add("loading", title, options),
    dismiss: (id?: string) => toaster.close(id),
    promise: <T,>(
      promise: Promise<T> | (() => Promise<T>),
      messages: {
        loading: React.ReactNode;
        success: React.ReactNode | ((data: T) => React.ReactNode);
        error: React.ReactNode | ((err: unknown) => React.ReactNode);
      },
    ) =>
      toaster.promise(
        typeof promise === "function" ? promise() : promise,
        {
          loading: { title: messages.loading, type: "loading" },
          success: (data) => ({
            title:
              typeof messages.success === "function"
                ? messages.success(data)
                : messages.success,
            type: "success",
          }),
          error: (err) => ({
            title:
              typeof messages.error === "function"
                ? messages.error(err)
                : messages.error,
            type: "error",
          }),
        },
      ),
  },
);

const typeIcon: Record<string, React.ReactNode> = {
  success: <CircleCheckIcon className="size-4 shrink-0 text-emerald-500" />,
  info: <InfoIcon className="size-4 shrink-0 text-sky-500" />,
  warning: <TriangleAlertIcon className="size-4 shrink-0 text-amber-500" />,
  error: <OctagonXIcon className="size-4 shrink-0 text-red-500" />,
  loading: (
    <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />
  ),
};

const positionClasses: Record<ToasterPosition, string> = {
  "top-left": "top-4 left-4",
  "top-center": "top-4 left-1/2 -translate-x-1/2",
  "top-right": "top-4 right-4",
  "bottom-left": "bottom-4 left-4",
  "bottom-center": "bottom-4 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-4 right-4",
};

const ToastList = () => {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => {
    const icon = t.type ? typeIcon[t.type] : null;
    return (
      <Toast.Root
        key={t.id}
        toast={t}
        className={cn(
          "bg-popover text-popover-foreground pointer-events-auto absolute inset-x-0 bottom-0 rounded-[var(--radius)] border shadow-lg",
          "transition-[transform,opacity] duration-300 ease-out",
          "z-[calc(1000-var(--toast-index))]",
          "[transform:translateY(calc(var(--toast-index)*-15%))_scale(calc(1-var(--toast-index)*0.05))]",
          "[opacity:calc(1-min(var(--toast-index),3)*0.25)]",
          "data-[expanded]:[transform:translateY(calc(var(--toast-offset-y)*-1))_scale(1)] data-[expanded]:opacity-100",
          "data-[swiping]:transition-none data-[swiping]:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-swipe-movement-y))]",
          "data-[starting-style]:translate-y-full data-[starting-style]:opacity-0",
          "data-[ending-style]:opacity-0",
          "data-[ending-style]:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
          "data-[ending-style]:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))]",
        )}
      >
        <div className="flex items-start gap-3 p-4 pr-9">
          {icon}
          <div className="min-w-0 flex-1 space-y-1">
            <Toast.Title className="text-sm leading-tight font-medium" />
            <Toast.Description className="text-muted-foreground text-sm leading-snug" />
          </div>
        </div>
        <Toast.Close
          aria-label="Close"
          className="text-muted-foreground focus-visible:ring-ring absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2"
        >
          <XIcon className="size-3.5" />
        </Toast.Close>
      </Toast.Root>
    );
  });
};

export const Toaster = ({
  position = "bottom-right",
}: {
  position?: ToasterPosition;
}) => (
  <Toast.Provider toastManager={toaster} limit={3}>
    <Toast.Portal>
      <Toast.Viewport
        className={cn(
          "pointer-events-none fixed z-[100] w-[356px] max-w-[calc(100vw-2rem)]",
          positionClasses[position],
          "[height:var(--toast-frontmost-height)] data-[expanded]:h-auto data-[expanded]:min-h-[var(--toast-frontmost-height)]",
          "transition-[height] duration-300 ease-out",
        )}
      >
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>
);
