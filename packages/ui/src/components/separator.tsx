"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "cn";

const Separator = ({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) => (
  <SeparatorPrimitive
    data-slot="separator"
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
      className,
    )}
    {...props}
  />
);

export { Separator };
