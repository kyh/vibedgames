"use client";

import type { ChatStatus, DataUIPart } from "ai";
import { create } from "zustand";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { useSandpackStore } from "@/components/sandpack/sandpack-store";
import { useMonitorStore } from "@/components/error-monitor/error-store";

// Simplified store that delegates to sandpack store
type SandboxStore = {
  chatStatus: ChatStatus;
  setChatStatus: (status: ChatStatus) => void;
  // Legacy URL for featured games discovery
  url: string;
  urlUUID?: string;
  setUrl: (url: string, uuid: string) => void;
  // Reset function
  reset: () => void;
};

const DEFAULT_URL = "https://astroid.vibedgames.com";

export const useSandboxStore = create<SandboxStore>()((set) => ({
  chatStatus: "ready",
  url: DEFAULT_URL,
  urlUUID: undefined,

  setChatStatus: (status) =>
    set((state) =>
      state.chatStatus === status ? state : { chatStatus: status },
    ),

  setUrl: (url, urlUUID) => set({ url, urlUUID }),

  reset: () =>
    set({
      chatStatus: "ready",
      url: DEFAULT_URL,
      urlUUID: undefined,
    }),
}));

/**
 * Hook to map data parts from AI stream to store actions
 * This connects the AI data stream to the sandpack store
 */
export function useDataStateMapper() {
  const { updateFiles, setProjectMetadata, addGeneratedFiles } =
    useSandpackStore();
  const { setCursor } = useMonitorStore();

  return (data: DataUIPart<DataPart>) => {
    switch (data.type) {
      case "data-project-metadata":
        if (
          data.data.status === "done" &&
          data.data.projectId &&
          data.data.buildNumber
        ) {
          setProjectMetadata(data.data.projectId, data.data.buildNumber);
        }
        break;

      case "data-generating-files":
        if (data.data.status === "done" && data.data.paths.length > 0) {
          addGeneratedFiles(data.data.paths);
          // Reset error cursor when files are generated
          setCursor(0);
        }
        break;

      case "data-file-content":
        if (data.data.files.length > 0) {
          updateFiles(data.data.files);
        }
        break;

      default:
        break;
    }
  };
}
