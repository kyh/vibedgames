import { WRAPPER_FRAME_NAME } from "@repo/embed/host";

interface Props {
  url?: string;
}

export const Iframe = ({ url }: Props) => (
  // oxlint-disable-next-line react/iframe-missing-sandbox -- games are first-party builds on their own origin, and every token they need (scripts, storage, pointer lock) adds back to a sandbox until it grants nothing
  <iframe
    key={url}
    name={WRAPPER_FRAME_NAME}
    src={url}
    className="h-full w-full"
    title="Game"
    allow="camera; microphone"
  />
);
