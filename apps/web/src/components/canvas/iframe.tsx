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
      // Games listen for keyboard input on their own window, but an iframe only
      // receives key events once it holds focus. Focus it on load so keyboard
      // controls work right away without the player first clicking the frame.
      onLoad={(event) => event.currentTarget.focus()}
    />
  );
};
