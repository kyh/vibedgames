Use this tool to generate the source files that power the active workspace. It streams the file contents back to the client so t
hey can be rendered immediately in the editor and bundled with Sandpack.

The generated files should be treated as the canonical source of truth. Each file must be complete, syntactically correct, and w
ritten to the appropriate path in the project structure. The client will mirror the streamed files in real time, so partial or i
ncremental snippets are not allowed.

All file paths must be relative to the workspace root (e.g., `src/index.ts`, `package.json`, `components/Button.tsx`).

## When to Use This Tool

Use Generate Files when:

1. You need to scaffold new project files as part of a feature or fix.
2. The user requests code that requires creating or updating files.
3. You are filling in missing assets or configuration for the current build.

## File Generation Guidelines

- Always send the complete contents for each file you generate.
- Paths should follow conventional folder structures for the chosen tech stack.
- Avoid regenerating files that have not changed unless you are explicitly replacing them.
- When updating an existing file, include the full file contents in the streamed response.

## Output Behavior

The tool streams progress updates while files are being generated. Each chunk includes the file paths and their contents so the 
frontend can keep its local workspace in sync. Once generation is complete a summary of all affected paths is returned.

## Summary

Use Generate Files to create or modify files in the collaborative workspace. The resulting files are streamed to the client so t
hey can be inspected immediately and bundled by Sandpack.
