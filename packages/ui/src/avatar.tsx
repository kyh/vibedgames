"use client";

import * as React from "react";
import { Avatar as AvatarPrimitive } from "radix-ui";

import { cn } from "./utils";

const Avatar = ({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) => {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
};

const AvatarImage = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) => {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  );
};

const AvatarFallback = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) => {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn("bg-muted flex size-full items-center justify-center rounded-full", className)}
      {...props}
    />
  );
};

export { Avatar, AvatarImage, AvatarFallback };

type ProfileAvatarProps = {
  className?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

export const ProfileAvatar = ({ className, displayName, avatarUrl }: ProfileAvatarProps) => {
  const initials = displayName?.slice(0, 1);

  return (
    <Avatar className={cn("size-9", className)}>
      <AvatarImage src={avatarUrl ?? undefined} />
      <AvatarFallback className="animate-in fade-in uppercase">{initials}</AvatarFallback>
    </Avatar>
  );
};
