import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useRef, useState } from "react";

import type { GameTag } from "@/components/game/data";
import { GAME_TAGS } from "@/components/game/data";
import type { BrowseInput, BrowseOutput, GalleryGame } from "@/lib/mcp-gallery-schema";
import { browseInput, browseOutput } from "@/lib/mcp-gallery-schema";

const TAG_LABELS: Record<GameTag, string> = {
  "3d": "3D",
  camera: "Webcam",
  multiplayer: "Multiplayer",
};

const SEARCH_DELAY_MS = 250;

type Gallery =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; result: BrowseOutput };

const failed: (message: string) => Gallery = (message) => ({ message, status: "failed" });

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
}

const fromResult: (result: ToolResult) => Gallery = (result) => {
  if (result.isError === true) {
    return failed("The gallery could not load.");
  }

  const parsed = browseOutput.safeParse(result.structuredContent);

  return parsed.success
    ? { result: parsed.data, status: "ready" }
    : failed("The gallery sent data this view cannot read.");
};

const TagList = ({ tags }: { tags: readonly GameTag[] }) =>
  tags.length === 0 ? null : (
    <ul className="tags">
      {tags.map((tag) => (
        <li key={tag}>{TAG_LABELS[tag]}</li>
      ))}
    </ul>
  );

const GameCard = ({ game, onOpen }: { game: GalleryGame; onOpen: (game: GalleryGame) => void }) => (
  <li>
    <button
      type="button"
      className="card"
      onClick={() => {
        onOpen(game);
      }}
    >
      <img src={game.coverUrl} alt="" loading="lazy" className="cover" />
      <span className="card-body">
        <span className="card-name">{game.name}</span>
        <TagList tags={game.tags} />
      </span>
    </button>
  </li>
);

interface DetailProps {
  app: App;
  canMessage: boolean;
  game: GalleryGame;
  onBack: () => void;
}

const GameDetail = ({ app, canMessage, game, onBack }: DetailProps) => (
  <article className="detail">
    <button type="button" className="back" onClick={onBack}>
      ← All games
    </button>
    <img src={game.coverUrl} alt={`${game.name} cover`} className="detail-cover" />
    <div className="detail-body">
      <h2>{game.name}</h2>
      <TagList tags={game.tags} />
      <p>{game.description}</p>
      <p className="host">{new URL(game.playUrl).host}</p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => {
            void app.openLink({ url: game.playUrl });
          }}
        >
          Play
        </button>
        {canMessage ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void app.sendMessage({
                content: [
                  {
                    text: `Help me build a browser game like ${game.name} (${game.playUrl}) with vibedgames.`,
                    type: "text",
                  },
                ],
                role: "user",
              });
            }}
          >
            Build one like it
          </button>
        ) : null}
      </div>
    </div>
  </article>
);

const useSearch = (app: App | null, onResult: (gallery: Gallery) => void) => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const run = async (connected: App, input: BrowseInput) => {
    try {
      onResult(
        fromResult(await connected.callServerTool({ arguments: input, name: "games_browse" })),
      );
    } catch {
      onResult(failed("The gallery could not load."));
    }
  };

  return (input: BrowseInput) => {
    clearTimeout(timer.current);

    if (app === null) {
      return;
    }

    timer.current = setTimeout(() => {
      void run(app, input);
    }, SEARCH_DELAY_MS);
  };
};

export const GalleryApp = () => {
  const [gallery, setGallery] = useState<Gallery>({ status: "loading" });
  const [changedContext, setChangedContext] = useState<McpUiHostContext>({});
  const [input, setInput] = useState<BrowseInput>({});
  const [open, setOpen] = useState<GalleryGame | null>(null);

  const { app, error } = useApp({
    appInfo: { name: "vibedgames-gallery", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.addEventListener("toolinput", ({ arguments: args }) => {
        const parsed = browseInput.safeParse(args ?? {});

        setInput(parsed.success ? parsed.data : {});
      });

      created.addEventListener("toolresult", (result) => {
        setGallery(fromResult(result));
      });

      created.addEventListener("hostcontextchanged", (changed) => {
        setChangedContext((previous) => ({ ...previous, ...changed }));
      });
    },
  });

  useHostStyles(app, app?.getHostContext());

  const search = useSearch(app, setGallery);

  const filter = (next: BrowseInput) => {
    setInput(next);
    search(next);
  };

  const canMessage = app?.getHostCapabilities()?.message !== undefined;
  const theme = changedContext.theme ?? app?.getHostContext()?.theme ?? "dark";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const openGame = (game: GalleryGame) => {
    setOpen(game);
    void app?.updateModelContext({
      content: [{ text: `The user is looking at ${game.name} (${game.playUrl}).`, type: "text" }],
    });
  };

  if (error) {
    return <p className="notice">Could not connect to the host: {error.message}</p>;
  }

  if (app && open) {
    return (
      <GameDetail
        app={app}
        canMessage={canMessage}
        game={open}
        onBack={() => {
          setOpen(null);
        }}
      />
    );
  }

  return (
    <main className="gallery">
      <header className="toolbar">
        <span className="brand">vibedgames</span>
        <input
          type="search"
          aria-label="Search games"
          placeholder="Search games"
          value={input.query ?? ""}
          onChange={(event) => {
            filter({ ...input, query: event.target.value });
          }}
        />
      </header>
      <nav className="filters" aria-label="Filter by tag">
        {[undefined, ...GAME_TAGS].map((tag) => (
          <button
            type="button"
            key={tag ?? "all"}
            aria-pressed={input.tag === tag}
            onClick={() => {
              filter({ ...input, tag });
            }}
          >
            {tag === undefined ? "All" : TAG_LABELS[tag]}
          </button>
        ))}
      </nav>
      {gallery.status === "loading" ? <p className="notice">Loading games…</p> : null}
      {gallery.status === "failed" ? <p className="notice">{gallery.message}</p> : null}
      {gallery.status === "ready" && gallery.result.games.length === 0 ? (
        <p className="notice">No games match. Try another word or tag.</p>
      ) : null}
      {gallery.status === "ready" ? (
        <ul className="grid">
          {gallery.result.games.map((game) => (
            <GameCard key={game.slug} game={game} onOpen={openGame} />
          ))}
        </ul>
      ) : null}
    </main>
  );
};
