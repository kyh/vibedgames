import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { cva } from "class-variance-authority";
import { Slot } from "radix-ui";

import { Spinner } from "./spinner";
import { cn } from "./utils";

const buttonVariants = cva(
  "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs",
        destructive:
          "bg-destructive hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60 text-white shadow-xs",
        outline:
          "bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 border shadow-xs",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 shadow-xs",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-md px-3 text-xs has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
      loading: {
        true: "disabled:opacity-100",
      },
    },
    compoundVariants: [
      {
        variant: "default",
        loading: true,
        className: "[&>:first-child]:bg-primary",
      },
      {
        variant: "destructive",
        loading: true,
        className: "[&>:first-child]:bg-destructive",
      },
      {
        variant: "outline",
        loading: true,
        className: "[&>:first-child]:bg-background",
      },
      {
        variant: "secondary",
        loading: true,
        className: "[&>:first-child]:bg-secondary",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const Button = ({
  className,
  variant,
  size,
  asChild = false,
  children,
  disabled,
  loading,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
  }) => {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, loading, className }))}
      disabled={loading ?? disabled}
      {...props}
    >
      {loading && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-md">
          <Spinner className="size-4" />
        </span>
      )}
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );
};

export { Button, buttonVariants };
