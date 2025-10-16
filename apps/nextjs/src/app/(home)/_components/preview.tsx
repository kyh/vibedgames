"use client";

import { Spinner } from "@repo/ui/spinner";
import { TextShimmer } from "@repo/ui/text-shimmer";

import { useV0 } from "./v0-provider";

export const Preview = () => {
  const { chatData, isBuilding, isLoading } = useV0();

  // Use current demoUrl if we're sending a message and building, otherwise use /demo
  const iframeSrc =
    isLoading || isBuilding ? "/demo" : chatData?.latestVersion?.demoUrl;

  return (
    <>
      {(isLoading || isBuilding) && (
        <Loading text={isLoading ? "Loading game..." : "Building game..."} />
      )}
      <iframe
        className="col-span-full row-span-full h-full w-full"
        src={iframeSrc}
      />
    </>
  );
};

const Loading = ({ text }: { text: string }) => {
  return (
    <div className="relative col-span-full row-span-full flex flex-col items-center justify-center gap-5">
      <div className="flex items-center gap-2">
        <Spinner />
        <TextShimmer className="font-mono text-sm" duration={1}>
          {text}
        </TextShimmer>
      </div>
    </div>
  );
};
