"use client";

import type {
  MentionsInputChangeEvent,
  MentionsInputProps,
} from "react-mentions-ts";
import {
  Mention,
  MentionsInput as ReactMentionsInput,
} from "react-mentions-ts";

import { InputGroupTextarea } from "./input-group";
import { cn } from "./utils";

export { Mention };

type MentionsInputPropsType<
  Extra extends Record<string, unknown> = Record<string, unknown>,
> = {
  className?: string;
} & Omit<MentionsInputProps<Extra>, "className" | "classNames">;

const mentionClassNames = {
  control: "border-none bg-transparent",
  highlighter: "px-3 py-2 border-none",
  input: "px-3 py-2 font-mono text-sm",
  inlineSuggestionText: "bg-accent",
  suggestions:
    "bg-popover text-popover-foreground border rounded-md shadow-md p-1 min-w-32 max-h-[200px] overflow-y-auto z-50 text-sm",
  suggestionsList: "",
  suggestionItem:
    "px-3 py-2 cursor-default rounded-sm transition-colors focus:bg-accent focus:text-accent-foreground",
  suggestionItemFocused: "bg-accent text-accent-foreground",
};

export const MentionsInput = ({
  className,
  ...props
}: MentionsInputPropsType) => {
  return (
    <ReactMentionsInput
      className={cn("flex-1", className)}
      classNames={mentionClassNames}
      inputComponent={InputGroupTextarea}
      {...props}
    />
  );
};

export type { MentionsInputChangeEvent };
