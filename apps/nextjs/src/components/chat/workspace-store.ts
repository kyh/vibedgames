import type { ChatStatus, DataUIPart } from "ai";
import { create } from "zustand";

import type { DataPart, DataPartFile } from "@repo/api/agent/messages/data-parts";
import { useMonitorStore } from "@/components/error-monitor/error-store";
import type { Line } from "@/components/error-monitor/schemas";

type WorkspaceState = {
  chatStatus: ChatStatus;
  projectId?: string;
  buildNumber?: number;
  files: Record<string, string>;
  paths: string[];
  generatedFiles: Set<string>;
  errors: Line[];
  setErrors: (errors: Line[]) => void;
  previewUrl?: string;
  previewUrlId?: string;
  setChatStatus: (status: ChatStatus) => void;
  hydrateWorkspace: (params: {
    projectId?: string;
    buildNumber?: number;
    files?: DataPartFile[];
  }) => void;
  upsertFiles: (files: DataPartFile[]) => void;
  markGenerated: (paths: string[]) => void;
  reset: () => void;
  setPreviewUrl: (url: string, uuid: string) => void;
};

const DEFAULT_PREVIEW_URL = "https://vibedgames.com/demo";

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  chatStatus: "ready",
  files: {},
  paths: [],
  generatedFiles: new Set<string>(),
  errors: [],
  previewUrl: DEFAULT_PREVIEW_URL,
  setChatStatus: (status) =>
    set((state) =>
      state.chatStatus === status ? state : { chatStatus: status },
    ),
  hydrateWorkspace: ({ projectId, buildNumber, files }) =>
    set(() => ({
      projectId,
      buildNumber,
      files: toRecord(files ?? []),
      paths: Array.from(new Set((files ?? []).map((file) => file.path))),
      generatedFiles: new Set((files ?? []).map((file) => file.path)),
    })),
  upsertFiles: (files) =>
    set((state) => {
      if (!files.length) return state;
      const nextFiles = { ...state.files };
      const nextGenerated = new Set(state.generatedFiles);
      for (const file of files) {
        nextFiles[file.path] = file.content;
        nextGenerated.add(file.path);
      }
      const nextPaths = Array.from(
        new Set([...state.paths, ...files.map((file) => file.path)]),
      );
      return {
        files: nextFiles,
        paths: nextPaths,
        generatedFiles: nextGenerated,
      };
    }),
  markGenerated: (paths) =>
    set((state) => ({
      generatedFiles: new Set([...state.generatedFiles, ...paths]),
      paths: Array.from(new Set([...state.paths, ...paths])),
    })),
  reset: () =>
    set(() => ({
      chatStatus: "ready",
      projectId: undefined,
      buildNumber: undefined,
      files: {},
      paths: [],
      generatedFiles: new Set<string>(),
      previewUrl: DEFAULT_PREVIEW_URL,
      previewUrlId: undefined,
    })),
  setPreviewUrl: (url, uuid) => set(() => ({ previewUrl: url, previewUrlId: uuid })),
  setErrors: (errors) => set(() => ({ errors })),
}));

function toRecord(files: DataPartFile[]) {
  return files.reduce<Record<string, string>>((acc, file) => {
    acc[file.path] = file.content;
    return acc;
  }, {});
}

export function useDataStateMapper() {
  const { setCursor } = useMonitorStore();
  const { hydrateWorkspace, upsertFiles, markGenerated } =
    useWorkspaceStore.getState();

  return (data: DataUIPart<DataPart>) => {
    switch (data.type) {
      case "data-workspace":
        if (data.data.status === "ready") {
          hydrateWorkspace({
            projectId: data.data.projectId,
            buildNumber: data.data.buildNumber,
            files: data.data.files,
          });
        }
        break;
      case "data-generating-files":
        if (data.data.files?.length) {
          upsertFiles(data.data.files);
          markGenerated(data.data.files.map((file) => file.path));
          setCursor(useWorkspaceStore.getState().errors.length);
        } else if (data.data.status === "done") {
          markGenerated(data.data.paths);
        }
        break;
      default:
        break;
    }
  };
}

export function useWorkspaceErrors() {
  const errors = useWorkspaceStore((state) => state.errors);
  return { errors };
}
