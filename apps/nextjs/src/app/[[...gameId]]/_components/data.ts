export type FeaturedGame = {
  id: number;
  name: string;
  preview: string;
  url?: string;
  files?: Record<string, string>;
  colorScheme: "light" | "dark";
};

export const featuredGames: FeaturedGame[] = [
  {
    id: 0,
    name: "Astroid",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/astroid.png",
    url: "https://astroid.vibedgames.com",
    colorScheme: "dark",
  },
  {
    id: 1,
    name: "Flappy Bird",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/flappy.png",
    url: "https://flappy-bird.vibedgames.com",
    colorScheme: "light",
  },
  {
    id: 2,
    name: "Pacman",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pacman.png",
    url: "https://pacman.vibedgames.com",
    colorScheme: "dark",
  },
  {
    id: 3,
    name: "Tetris",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/tetris.png",
    url: "https://tetris.vibedgames.com",
    colorScheme: "dark",
  },
  {
    id: 4,
    name: "Pong",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pong.png",
    url: "https://pong.vibedgames.com",
    colorScheme: "light",
  },
  {
    id: 5,
    name: "Local Test Game",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pong.png",
    colorScheme: "light",
    files: {
      "package.json": JSON.stringify(
        {
          name: "local-test-game",
          version: "1.0.0",
          type: "module",
          dependencies: {
            react: "^18.2.0",
            "react-dom": "^18.2.0",
          },
        },
        null,
        2,
      ),
      "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Local Test Game</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
      "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);`,
      "src/App.tsx": `import { useState } from "react";

function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ 
      display: "flex", 
      flexDirection: "column", 
      alignItems: "center", 
      justifyContent: "center", 
      minHeight: "100vh",
      fontFamily: "system-ui, sans-serif",
      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      color: "white"
    }}>
      <h1 style={{ fontSize: "3rem", marginBottom: "2rem" }}>
        Local Test Game
      </h1>
      <div style={{ 
        background: "rgba(255, 255, 255, 0.2)", 
        padding: "2rem", 
        borderRadius: "1rem",
        backdropFilter: "blur(10px)"
      }}>
        <p style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
          Count: {count}
        </p>
        <button
          onClick={() => setCount(count + 1)}
          style={{
            padding: "0.75rem 1.5rem",
            fontSize: "1rem",
            borderRadius: "0.5rem",
            border: "none",
            background: "white",
            color: "#667eea",
            cursor: "pointer",
            fontWeight: "bold",
          }}
        >
          Click me!
        </button>
      </div>
    </div>
  );
}

export default App;`,
    },
  },
];
