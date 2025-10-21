import { cn } from "@repo/ui/utils";

export type CardProps = {
  id: number;
  name: string;
  description: string;
  slug: string;
  type: string;
  plays: number;
};

export const Card = ({ name, description, slug, type, plays }: CardProps) => {
  const formattedPlays = Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(plays);

  return (
    <div className="group relative flex h-[382px] w-[344px] cursor-pointer flex-col items-center bg-[url(/home/card.png)] bg-cover bg-center bg-no-repeat transition-transform duration-300 ease-in-out">
      <h4 className="absolute top-[128px] left-[-52px] -rotate-90 text-xs tracking-[3px] text-[#606060] uppercase [text-shadow:0px_1.5px_1px_#000000]">
        vibedgames.com
      </h4>

      <div className="absolute top-[7px] right-5 flex">
        <img
          src={`/${slug}/icon.png`}
          className="h-[26px] rounded-md border border-[rgba(220,220,220,0.2)] drop-shadow-[1px_1px_4px_rgba(255,0,0,0.4)]"
          alt={`${name} logo`}
        />
      </div>

      <div className="relative mt-[60px] ml-[10px] flex h-[260px] w-[260px] flex-col rounded-xl bg-[linear-gradient(160deg,rgba(103,103,103,0.25)_14%,rgba(14,14,14,0.2)_97.3%),#0c0c0c] p-[14px_12px] shadow-[0.6px_0.6px_0px_rgba(255,255,255,0.297),inset_0px_4.8px_4.8px_rgba(0,0,0,0.2),inset_2px_3px_1.2px_rgba(0,0,0,0.45)]">
        <h3 className="font-bold tracking-[0.3px] uppercase [text-shadow:2px_2px_0.2px_rgba(0,0,0,0.7)]">
          {name}
        </h3>
        <p className="mt-2 line-clamp-2 overflow-hidden text-sm leading-4 font-normal tracking-[-0.5px]">
          {description}
        </p>

        <div className="mt-auto mb-2 flex w-full flex-row items-center justify-between">
          <div className="flex items-center gap-1 text-[10px] uppercase">
            {formattedPlays}
          </div>
          <div
            className={cn(
              "rounded-sm bg-[rgba(95,95,95,0.2)] px-1.5 py-0.5 text-[10px] tracking-wider uppercase",
              type === "published" ? "text-[#68ff32]" : "text-[#fffa6d]",
            )}
          >
            {type}
          </div>
        </div>
        <img
          src={`/${slug}/thumbnail.png`}
          className="rounded-md"
          alt={`${name} thumbnail`}
        />
      </div>

      <div className="absolute bottom-[17.5px] left-[calc(50%+10px)] h-6 w-[38px] -translate-x-1/2">
        <img
          src="/home/cut.png"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-all duration-300 ease-in-out group-hover:opacity-0"
          alt="Cut normal"
        />
        <img
          src="/home/cut-hover.png"
          className="absolute top-1/2 left-1/2 max-w-[94px] -translate-x-1/2 -translate-y-1/2 opacity-0 mix-blend-overlay transition-all duration-300 ease-in-out group-hover:opacity-100"
          alt="Cut hover"
        />
      </div>
    </div>
  );
};
