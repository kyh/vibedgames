import { create } from "zustand";

import { featuredGames } from "./data";

type View = "play" | "discover";

type UIState = {
  view: View;
  setView: (view: View) => void;
  iframe: HTMLIFrameElement | null;
  setIframe: (iframe: HTMLIFrameElement | null) => void;
  refreshIframe: () => void;
  iframeLoading: boolean;
  setIframeLoading: (loading: boolean) => void;
  iframeError: string | null;
  setIframeError: (error: string | null) => void;
  gameId: string;
  setGameId: (id: string) => void;
};

export const useUiStore = create<UIState>((set, get) => ({
  view: "play",
  setView: (view) => set({ view }),
  iframe: null,
  setIframe: (iframe) => set({ iframe }),
  refreshIframe: () => {
    const iframe = get().iframe;
    if (!iframe) return;

    set({ iframeLoading: true, iframeError: null });

    const newUrl = new URL(iframe.src);
    newUrl.searchParams.set("t", Date.now().toString());
    iframe.src = newUrl.toString();
  },
  iframeLoading: false,
  setIframeLoading: (loading) => set({ iframeLoading: loading }),
  iframeError: null,
  setIframeError: (error) => set({ iframeError: error }),
  gameId: featuredGames[0]?.url ?? "",
  setGameId: (id) => set({ gameId: id }),
}));
