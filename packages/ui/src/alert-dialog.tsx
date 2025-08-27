"use client";

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { Button, buttonVariants } from "./button";
import { cn } from "./utils";

const AlertDialog = ({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) => {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
};

const AlertDialogTrigger = ({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) => {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  );
};

const AlertDialogPortal = ({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) => {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  );
};

const AlertDialogOverlay = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) => {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className,
      )}
      {...props}
    />
  );
};

const AlertDialogContent = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) => {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
};

const AlertDialogHeader = ({
  className,
  ...props
}: React.ComponentProps<"div">) => {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
};

const AlertDialogFooter = ({
  className,
  ...props
}: React.ComponentProps<"div">) => {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
};

const AlertDialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  );
};

const AlertDialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
};

const AlertDialogAction = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) => {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants(), className)}
      {...props}
    />
  );
};

const AlertDialogCancel = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) => {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  );
};

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};

/**
 * We save the global alert dialog state outside of react so that we can follow the same api pattern
 * as `toasts` and call `alert.open` from anywhere in the app.
 */
export type AlertState = {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: {
    hidden?: boolean;
    label?: React.ReactNode;
    onClick?: () => void | Promise<unknown>;
  };
  cancel?: {
    hidden?: boolean;
    label?: React.ReactNode;
    onClick?: () => void | Promise<unknown>;
  };
};

type Listener = () => void;

const alertDialogStore = {
  state: {
    open: false,
    title: "",
  } as AlertState,
  listeners: [] as Listener[],
  subscribe: (listener: Listener) => {
    alertDialogStore.listeners.push(listener);
    return () => {
      alertDialogStore.listeners = alertDialogStore.listeners.filter(
        (l) => l !== listener,
      );
    };
  },
  getSnapshot: () => {
    return alertDialogStore.state;
  },
  emitChange: () => {
    alertDialogStore.listeners.forEach((listener) => listener());
  },
};

export const alertDialog = {
  open: (
    title: React.ReactNode,
    options: Omit<AlertState, "open" | "title">,
  ) => {
    alertDialogStore.state = {
      ...alertDialogStore.state,
      ...options,
      open: true,
      title,
    };
    alertDialogStore.emitChange();
  },
  close: () => {
    alertDialogStore.state = {
      ...alertDialogStore.state,
      open: false,
    };
    alertDialogStore.emitChange();
  },
};

export const GlobalAlertDialog = () => {
  const [pendingAction, setPendingAction] = React.useState(false);
  const [pendingCancel, setPendingCancel] = React.useState(false);
  const alertState = React.useSyncExternalStore(
    alertDialogStore.subscribe,
    alertDialogStore.getSnapshot,
    alertDialogStore.getSnapshot,
  );

  const onOpenChange = (open: boolean) => {
    if (pendingAction || pendingCancel) return;
    if (!open) {
      setPendingCancel(true);
      const res = alertState.cancel?.onClick?.();
      if (res instanceof Promise) {
        void res.then(() => {
          setPendingCancel(false);
          alertDialog.close();
        });
      } else {
        setPendingCancel(false);
        alertDialog.close();
      }
    }
  };

  const onConfirm = () => {
    setPendingAction(true);
    const res = alertState.action?.onClick?.();
    if (res instanceof Promise) {
      void res.then(() => {
        setPendingAction(false);
        alertDialog.close();
      });
    } else {
      setPendingAction(false);
      alertDialog.close();
    }
  };

  return (
    <AlertDialog open={alertState.open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{alertState.title}</AlertDialogTitle>
        </AlertDialogHeader>
        {alertState.description && (
          <AlertDialogDescription>
            {alertState.description}
          </AlertDialogDescription>
        )}
        <AlertDialogFooter>
          {!alertState.action?.hidden && (
            <Button onClick={onConfirm} loading={pendingAction}>
              {alertState.action?.label ?? "Confirm"}
            </Button>
          )}
          {!alertState.cancel?.hidden && (
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
              loading={pendingCancel}
            >
              {alertState.cancel?.label ?? "Close"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
