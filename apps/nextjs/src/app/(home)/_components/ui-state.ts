"use client";

import { create } from "zustand";

type View = "build" | "play" | "discover";

export const uiState = create<{
  view: View;
  setView: (view: View) => void;
  previewIframe: HTMLIFrameElement | null;
  setPreviewIframe: (iframe: HTMLIFrameElement | null) => void;
  refreshPreviewIframe: () => void;
  isPreviewIframeLoading: boolean;
  setIsPreviewIframeLoading: (loading: boolean) => void;
  previewIframeError: string | null;
  setPreviewIframeError: (error: string | null) => void;
}>((set, get) => ({
  view: "play",
  setView: (view) => set({ view }),
  previewIframe: null,
  setPreviewIframe: (iframe) => set({ previewIframe: iframe }),
  refreshPreviewIframe: () => {
    const previewIframe = get().previewIframe;
    if (!previewIframe) return;

    // Set loading state and clear any errors
    set({ isPreviewIframeLoading: true, previewIframeError: null });

    const newUrl = new URL(previewIframe.src);
    newUrl.searchParams.set("t", Date.now().toString());
    previewIframe.src = newUrl.toString();
  },
  isPreviewIframeLoading: false,
  setIsPreviewIframeLoading: (loading) =>
    set({ isPreviewIframeLoading: loading }),
  previewIframeError: null,
  setPreviewIframeError: (error) => set({ previewIframeError: error }),
}));
