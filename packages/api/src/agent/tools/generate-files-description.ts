const prompt = `Use this tool to generate and return code files for the in-browser Sandpack runtime. It leverages an LLM to create file contents based on the current conversation context and user intent, then streams them back to the client for immediate preview.

The generated files should be considered correct on first iteration and suitable for immediate use in the Sandpack environment. This tool is essential for scaffolding applications, adding new features, writing configuration files, or fixing missing components.

All file paths must be relative to the project root (e.g., \`src/index.ts\`, \`package.json\`, \`components/Button.tsx\`).

## When to Use This Tool

Use Generate Files when:

1. You need to create one or more new files as part of a feature, scaffold, or fix
2. The user requests code that implies file creation (e.g., new routes, APIs, components, services)
3. You need to bootstrap a new application structure
4. You're completing a multi-step task that involves generating or updating source code
5. A prior attempt failed due to a missing file, and you need to supply it

## File Generation Guidelines

- Every file must be complete, valid, and runnable where applicable
- File contents must reflect the user's intent and the overall session context
- File paths must be well-structured and use consistent naming conventions
- Generated files should assume compatibility with other existing files in the project
- If generating \`vite.config.ts\`, make sure to set \`server.allowedHosts\` to \`true\`

## Best Practices

- Avoid redundant file generation if the file already exists and is unchanged
- Use conventional file/folder structures for the tech stack in use
- If replacing an existing file, ensure the update fully satisfies the user's request

## Examples of When to Use This Tool

<example>
User: Add a \`NavBar.tsx\` component and include it in \`App.tsx\`
Assistant: I'll generate the \`NavBar.tsx\` file and update \`App.tsx\` to include it.
*Uses Generate Files to create:*
- \`components/NavBar.tsx\`
- Modified \`App.tsx\` with import and usage of \`NavBar\`
</example>

<example>
User: Let's scaffold a simple React app with a counter component.
Assistant: I'll generate the necessary files for the React app.
*Uses Generate Files to create:*
- \`package.json\` with React as a dependency
- \`src/App.tsx\` with counter component
- \`src/main.tsx\` with app entry point
- \`index.html\` with root element
</example>

## Output Behavior

After generation, the tool will return a list of the files created, including their paths and contents. These can then be inspected, referenced, or used in subsequent operations.

## Summary

Use Generate Files to programmatically create or update files for in-browser preview with Sandpack. It enables fast iteration, contextual coding, and dynamic file management — all driven by user intent and conversation context.`;

export default prompt;
