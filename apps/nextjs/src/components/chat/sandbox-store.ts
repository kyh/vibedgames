import type { ChatStatus, DataUIPart } from "ai";
import { create } from "zustand";

import type { DataPart } from "@repo/api/agent/messages/data-parts";

type SandpackStore = {
  sandpackFiles: Record<string, string>;
  chatStatus: ChatStatus;
  setChatStatus: (status: ChatStatus) => void;
  setSandpackFiles: (files: Record<string, string>) => void;
  reset: () => void;
};

export const useSandpackStore = create<SandpackStore>()((set) => ({
  sandpackFiles: {},
  chatStatus: "ready",
  setChatStatus: (status) =>
    set((state) =>
      state.chatStatus === status ? state : { chatStatus: status },
    ),
  setSandpackFiles: (files) =>
    set((state) => ({
      sandpackFiles: { ...state.sandpackFiles, ...files },
    })),
  reset: () =>
    set(() => ({
      sandpackFiles: {},
    })),
}));

export function useDataStateMapper() {
  const { setSandpackFiles } = useSandpackStore();

  return (data: DataUIPart<DataPart>) => {
    switch (data.type) {
      case "data-generating-files":
        if (data.data.files) {
          setSandpackFiles(data.data.files);
        }
        break;
      default:
        break;
    }
  };
}
