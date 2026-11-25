export { BlenderJob } from "./blender-job";

export { RecipeJob } from "./job";

const JOB = /^\/jobs\/(?<id>rcp_(?<image>tools|blender)_[\w-]{8,64})(?:\/|$)/u;

/** Reached only over the web Worker's service binding: it has no route and no workers.dev URL. */
export default {
  fetch: (request: Request, env: Env) => {
    const match = JOB.exec(new URL(request.url).pathname)?.groups;

    if (!match?.id) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const namespace = match.image === "blender" ? env.BLENDER : env.TOOLS;

    return namespace.getByName(match.id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
