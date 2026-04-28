"use client";

import { OTPFieldPreview as OTPFieldPrimitive } from "@base-ui/react/otp-field";
import type * as React from "react";

import { cn } from "@repo/ui/lib/utils";
import { Separator } from "@repo/ui/components/separator";

function OTPField({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof OTPFieldPrimitive.Root> & {
  size?: "default" | "lg";
}) {
  return (
    <OTPFieldPrimitive.Root
      data-slot="otp-field"
      data-size={size}
      className={cn(
        "flex items-center gap-2 has-disabled:opacity-64 has-disabled:**:data-[slot=otp-field-input]:shadow-none has-disabled:**:data-[slot=otp-field-input]:before:shadow-none!",
        className,
      )}
      {...props}
    />
  );
}

function OTPFieldInput({
  className,
  ...props
}: React.ComponentProps<typeof OTPFieldPrimitive.Input>) {
  return (
    <OTPFieldPrimitive.Input
      data-slot="otp-field-input"
      spellCheck={false}
      className={cn(
        "relative size-9 min-w-0 rounded-lg border border-input bg-background text-center text-base text-foreground leading-9 shadow-xs/5 outline-none ring-ring/24 transition-shadow",
        "before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-focus-visible:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)]",
        "focus-visible:z-10 focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        "aria-invalid:border-destructive/36 aria-invalid:shadow-none aria-invalid:focus-visible:border-destructive/64 aria-invalid:focus-visible:ring-destructive/16",
        "in-[[data-slot=otp-field][data-size=lg]]:size-10 in-[[data-slot=otp-field][data-size=lg]]:text-lg in-[[data-slot=otp-field][data-size=lg]]:leading-10",
        "sm:size-8 sm:text-sm sm:leading-8 sm:in-[[data-slot=otp-field][data-size=lg]]:size-9 sm:in-[[data-slot=otp-field][data-size=lg]]:text-base sm:in-[[data-slot=otp-field][data-size=lg]]:leading-9",
        "dark:bg-input/32 dark:aria-invalid:focus-visible:ring-destructive/24 dark:not-focus-visible:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] not-dark:bg-clip-padding",
        className,
      )}
      {...props}
    />
  );
}

function OTPFieldSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <OTPFieldPrimitive.Separator
      render={
        <Separator
          orientation="horizontal"
          className={cn(
            "rounded-full bg-input data-[orientation=horizontal]:h-0.5 data-[orientation=horizontal]:w-3",
            className,
          )}
          {...props}
        />
      }
    />
  );
}

export { OTPField, OTPFieldInput, OTPFieldSeparator };
