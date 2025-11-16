Use this tool to prepare the collaborative workspace for a build session. It ensures the project exists, loads or creates the cur
rent build record, and streams any previously saved files back to the client so Sandpack can boot with the right sources.

Call this tool once at the start of a session or when switching between saved projects/builds. After the workspace is ready you c
an start generating files immediately — there is no remote sandbox to manage.

The tool responds with the project/build identifiers and the full contents of every persisted file for that build.
