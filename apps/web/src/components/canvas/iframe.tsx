type Props = {
  url?: string;
};

export const Iframe = ({ url }: Props) => {
  return (
    <iframe
      key={url}
      src={url}
      className="h-full w-full"
      title="Game"
      allow="camera; microphone"
    />
  );
};
