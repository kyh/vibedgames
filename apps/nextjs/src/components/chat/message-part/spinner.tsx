import { Spinner as SpinnerIcon } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";

export const Spinner = ({
  className,
  loading,
  children,
}: {
  className?: string;
  loading: boolean;
  children?: React.ReactNode;
}) => {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center",
        className,
      )}
    >
      {loading ? <SpinnerIcon size={2} gridSize={2} /> : children}
    </span>
  );
};
