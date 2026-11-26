import { z } from "zod";

const MARKER = "<!-- worker-previews -->";
const STATE = /<!-- worker-previews-state:(?<rows>[A-Za-z0-9+/=]*) -->/u;
const api = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${process.env.GITHUB_REPOSITORY ?? ""}`;

const env = (name: string) => {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`worker-preview: ${name} is not set`);
  }

  return value;
};

const STATES = ["building", "deleted", "error", "ready"] as const;

type PreviewState = (typeof STATES)[number];

const STATUS = {
  building: { deployment: "in_progress", icon: "🔄", label: "Building" },
  deleted: { deployment: "inactive", icon: "🗑️", label: "Deleted" },
  error: { deployment: "failure", icon: "❌", label: "Failed" },
  ready: { deployment: "success", icon: "✅", label: "Ready" },
} satisfies Record<PreviewState, { deployment: string; icon: string; label: string }>;

const comment = z.looseObject({ body: z.string().nullish(), id: z.number() });

const deployment = z.looseObject({
  id: z.number(),
  payload: z.looseObject({ pr: z.coerce.string().optional() }).catch({}),
  sha: z.string(),
});

type Deployment = z.infer<typeof deployment>;

const row = z.object({
  inspect: z.string(),
  state: z.enum(STATES),
  updated: z.string(),
  url: z.string().optional(),
});

const rowsSchema = z.record(z.string(), row);

type Rows = z.infer<typeof rowsSchema>;

type RequestBody = Record<
  string,
  boolean | number | string | string[] | { pr: string } | undefined
>;

const request = async (method: string, path: string, body?: RequestBody) => {
  const init: RequestInit = {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
    },
    method,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${api}${path}`, init);

  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  }

  return response;
};

const gh = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: RequestBody) => {
  const response = await request(method, path, body);

  return schema.parse(await response.json());
};

const environmentOf = (project: string) => `Preview – ${project}`;

const updatedAt = () =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  })
    .format(new Date())
    .replace(
      /, (?<time>\d+:\d\d) (?<half>AM|PM)$/u,
      (_match, time: string, half: string) => ` ${time}${half.toLowerCase()}`,
    );

const render = (rows: Rows) => {
  const lines = Object.entries(rows)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([project, entry]) => {
      const { icon, label } = STATUS[entry.state];
      const status = `${icon} [${label}](${entry.inspect})`;

      const preview =
        entry.url !== undefined && entry.url !== "" && entry.state !== "deleted"
          ? `[Visit Preview](${entry.url})`
          : "";

      return `| **${project}** | ${status} | ${preview} | ${entry.updated} |`;
    });

  const state = Buffer.from(JSON.stringify(rows)).toString("base64");

  return [
    MARKER,
    `<!-- worker-previews-state:${state} -->`,
    "**The latest updates on your projects.** Learn more about [Cloudflare Worker Previews](https://developers.cloudflare.com/workers/previews/).",
    "",
    "| Name | Status | Preview | Updated (UTC) |",
    "| :--- | :----- | :------ | :------------ |",
    ...lines,
  ].join("\n");
};

const findComment: (
  pr: string,
  page?: number,
) => Promise<z.infer<typeof comment> | undefined> = async (pr, page = 1) => {
  const comments = await gh(
    "GET",
    `/issues/${pr}/comments?per_page=100&page=${page}`,
    z.array(comment),
  );

  const found = comments.find((entry) => entry.body?.startsWith(MARKER) === true);

  if (found !== undefined || comments.length < 100) {
    return found;
  }

  return await findComment(pr, page + 1);
};

const rowsOf = (body: string | null | undefined) => {
  const encoded = body?.match(STATE)?.groups?.rows;

  if (encoded === undefined || encoded === "") {
    return {};
  }

  return rowsSchema.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")));
};

const upsertRows = async (pr: string, update: (rows: Rows) => boolean) => {
  const found = await findComment(pr);
  const rows = rowsOf(found?.body);

  if (!update(rows)) {
    return;
  }

  const body = render(rows);
  await (found
    ? request("PATCH", `/issues/comments/${found.id}`, { body })
    : request("POST", `/issues/${pr}/comments`, { body }));
};

const deploymentsOf = async (project: string, pr: string) => {
  const environment = encodeURIComponent(environmentOf(project));

  const deployments = await gh(
    "GET",
    `/deployments?environment=${environment}&per_page=100`,
    z.array(deployment),
  );

  return deployments.filter((entry) => entry.payload.pr === pr);
};

const deploymentFor = async (project: string, pr: string, sha: string) => {
  const deployments = await deploymentsOf(project, pr);
  const existing = deployments.find((entry) => entry.sha === sha);

  return (
    existing ??
    (await gh("POST", "/deployments", deployment, {
      auto_merge: false,
      description: `Cloudflare Worker Preview of ${project}`,
      environment: environmentOf(project),
      payload: { pr },
      production_environment: false,
      ref: sha,
      required_contexts: [],
      transient_environment: true,
    }))
  );
};

const deactivate = async (deployments: Deployment[]) => {
  await Promise.all(
    deployments.map(
      async (entry) =>
        await request("POST", `/deployments/${entry.id}/statuses`, { state: "inactive" }),
    ),
  );
};

const report = async (project: string, state: string, url: string | undefined) => {
  const parsed = z.enum(STATES).exclude(["deleted"]).safeParse(state);

  if (!parsed.success) {
    throw new Error(`worker-preview: unknown state "${state}"`);
  }

  const known = parsed.data;
  const pr = env("PR_NUMBER");
  const inspect = env("RUN_URL");
  const target = await deploymentFor(project, pr, env("HEAD_SHA"));
  const environmentUrl = url === undefined || url === "" ? undefined : url;

  await request("POST", `/deployments/${target.id}/statuses`, {
    auto_inactive: false,
    environment_url: environmentUrl,
    log_url: inspect,
    state: STATUS[known].deployment,
  });

  if (known === "ready") {
    const deployments = await deploymentsOf(project, pr);
    await deactivate(deployments.filter((older) => older.id !== target.id));
  }

  await upsertRows(pr, (rows) => {
    const next: Rows[string] = { inspect, state: known, updated: updatedAt() };
    const kept = environmentUrl ?? rows[project]?.url;

    if (kept !== undefined) {
      next.url = kept;
    }

    rows[project] = next;

    return true;
  });
};

const close = async (projects: string[]) => {
  const pr = env("PR_NUMBER");

  await Promise.all(
    projects.map(async (project) => {
      await deactivate(await deploymentsOf(project, pr));
    }),
  );

  await upsertRows(pr, (rows) => {
    let changed = false;

    for (const project of projects) {
      const existing = rows[project];

      if (existing) {
        rows[project] = { ...existing, state: "deleted", updated: updatedAt() };
        changed = true;
      }
    }

    return changed;
  });
};

const [command, ...args] = process.argv.slice(2);

if (command === "report") {
  const [project, state, url] = args;

  if (project === undefined || state === undefined) {
    throw new Error("usage: worker-preview.ts report <project> <state> [url]");
  }

  await report(project, state, url);
} else if (command === "close") {
  await close(args);
} else {
  throw new Error("usage: worker-preview.ts report <project> <state> [url] | close <project>...");
}
