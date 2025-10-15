import { CheckIcon, CloudUploadIcon, XIcon } from "lucide-react";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { ToolHeader } from "../tool-header";
import { ToolMessage } from "../tool-message";
import { Spinner } from "./spinner";

export const GenerateFiles = (props: {
  className?: string;
  message: DataPart["generating-files"];
}) => {
  const lastInProgress = ["error", "uploading", "generating"].includes(
    props.message.status,
  );

  const generated = lastInProgress
    ? props.message.paths.slice(0, props.message.paths.length - 1)
    : props.message.paths;

  const generating = lastInProgress
    ? (props.message.paths[props.message.paths.length - 1] ?? "")
    : null;

  return (
    <ToolMessage className={props.className}>
      <ToolHeader>
        <CloudUploadIcon className="h-3.5 w-3.5" />
        <span>
          {props.message.status === "done"
            ? "Uploaded files"
            : "Generating files"}
        </span>
      </ToolHeader>
      <div className="relative min-h-5 text-sm">
        {generated.map((path) => (
          <div className="flex items-center" key={"gen" + path}>
            <CheckIcon className="mx-1 h-4 w-4" />
            <span className="whitespace-pre-wrap">{path}</span>
          </div>
        ))}
        {typeof generating === "string" && (
          <div className="flex">
            <Spinner
              className="mr-1"
              loading={props.message.status !== "error"}
            >
              {props.message.status === "error" ? (
                <XIcon className="h-4 w-4 text-red-700" />
              ) : (
                <CheckIcon className="h-4 w-4" />
              )}
            </Spinner>
            <span>{generating}</span>
          </div>
        )}
      </div>
    </ToolMessage>
  );
};
