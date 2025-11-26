Use this tool to generate code files for a game or application. It leverages an LLM to create file contents based on the current conversation context and user intent, then streams them to the client-side sandbox for immediate preview.

The generated files are bundled and executed in the browser using CodeSandbox's Sandpack. This allows for instant preview without server-side containers.

All file paths must be relative to the project root (e.g., `src/main.jsx`, `package.json`, `components/Button.tsx`).

## When to Use This Tool

Use Generate Files when:

1. You need to create one or more new files as part of a feature, scaffold, or fix
2. The user requests code that implies file creation (e.g., new components, game logic, assets)
3. You need to bootstrap a new application or game structure
4. You're completing a multi-step task that involves generating or updating source code
5. A build error occurred and you need to fix or add missing files

## File Generation Guidelines

- Every file must be complete, valid, and runnable
- File contents must reflect the user's intent and the overall session context
- File paths must be well-structured and use consistent naming conventions
- The sandbox uses Vite + React by default, so prefer `.jsx` or `.tsx` files for components
- For games, you can use plain JavaScript, React, Three.js, Phaser, or similar libraries

## Framework Support

The client-side sandbox supports:
- **Vite + React** (default template)
- **Plain JavaScript/TypeScript**
- **Popular game libraries**: Three.js, Phaser, PixiJS, etc.

When generating files:
- Include a `package.json` with the required dependencies
- Use ES modules (import/export syntax)
- The entry point should be `src/main.jsx` or `src/main.tsx` for React apps

## Best Practices

- Avoid redundant file generation if the file already exists and is unchanged
- Use conventional file/folder structures for the tech stack in use
- If replacing an existing file, ensure the update fully satisfies the user's request
- Keep dependencies minimal for faster bundling

## Examples of When to Use This Tool

<example>
User: Create a simple Pong game
Assistant: I'll generate the files for a Pong game using React and Canvas.
*Uses Generate Files to create:*
- `package.json` with dependencies
- `src/main.jsx` entry point
- `src/App.jsx` main game component
- `src/components/Game.jsx` game logic
</example>

<example>
User: Add a score display to the game
Assistant: I'll update the game component to include a score display.
*Uses Generate Files to update:*
- `src/components/Game.jsx` with score tracking and display
</example>

## When NOT to Use This Tool

Avoid using this tool when:

1. You're just explaining concepts or providing documentation
2. The user is asking questions without requesting code changes
3. You need to read existing file contents first (read them, then generate updates)

## Output Behavior

After generation, the files are streamed to the client-side sandbox where they are immediately bundled and rendered. The user will see the preview update in real-time as files are generated.

## Summary

Use Generate Files to create or update files for the game. Files are streamed to the browser's Sandpack sandbox for instant preview — no server-side containers required.
