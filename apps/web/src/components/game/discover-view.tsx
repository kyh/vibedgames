import { useNavigate } from "@tanstack/react-router";
import { motion } from "motion/react";

import { featuredGames } from "./data";

type Props = {
  onHover: (url: string) => void;
};

export const DiscoverView = ({ onHover }: Props) => {
  const navigate = useNavigate({ from: "/" });

  return (
    <motion.div
      className="flex gap-4 overflow-auto pb-4 md:flex-col-reverse"
      transition={{ type: "spring", bounce: 0.1 }}
      initial={{ opacity: 0, filter: "blur(5px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: 0.05 } }}
    >
      {featuredGames.map((game) => (
        <button
          key={game.url}
          onMouseEnter={() => onHover(game.url)}
          onClick={() => {
            navigate({ search: { view: "play", game: game.url } });
          }}
          className="hover:border-foreground relative aspect-video w-30 shrink-0 overflow-clip rounded-lg border border-transparent transition-colors"
        >
          <img
            src={game.preview}
            alt={game.name}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </button>
      ))}
    </motion.div>
  );
};
