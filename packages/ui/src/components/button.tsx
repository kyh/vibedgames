import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useWebHaptics } from "web-haptics/react";

import { Spinner } from "@repo/ui/components/spinner";
import { cn } from "cn";

const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    compoundVariants: [
      {
        // Loading also sets `disabled`; keep the primary fill (not the muted
        // disabled fill) so a loading button still reads as primary.
        className:
          "disabled:bg-primary disabled:text-primary-foreground [&>:first-child]:bg-primary",
        loading: true,
        variant: "default",
      },
      { className: "[&>:first-child]:bg-destructive/10", loading: true, variant: "destructive" },
      { className: "[&>:first-child]:bg-background", loading: true, variant: "outline" },
      { className: "[&>:first-child]:bg-secondary", loading: true, variant: "secondary" },
      { className: "[&>:first-child]:bg-background", loading: true, variant: "ghost" },
      { className: "[&>:first-child]:bg-background", loading: true, variant: "link" },
    ],
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      loading: {
        true: "disabled:opacity-100",
      },
      size: {
        default:
          "h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-9",
        "icon-lg": "size-10",
        "icon-sm":
          "size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        lg: "h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        outline:
          "border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
      },
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
  };

const Button = ({
  className,
  variant = "default",
  size = "default",
  loading,
  disabled,
  children,
  onClick,
  ...props
}: ButtonProps) => {
  const { trigger } = useWebHaptics();
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ className, loading, size, variant }))}
      disabled={loading || disabled}
      onClick={(event) => {
        trigger(variant === "destructive" ? "warning" : "selection");
        onClick?.(event);
      }}
      {...props}
    >
      {loading && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-md">
          <Spinner className="size-4" />
        </span>
      )}
      {children}
    </ButtonPrimitive>
  );
};

export { Button, buttonVariants };
