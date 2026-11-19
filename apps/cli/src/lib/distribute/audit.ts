import type { PortalLimits, PortalSdk } from "./portals.js";

/**
 * What a portal does to a build that vibedgames does not: it unpacks a zip
 * under a path it chooses, inside an iframe on its own origin, within limits it
 * sets. Each check here is one way a build that plays at
 * `{slug}.vibedgames.com` fails once that happens.
 */

export interface BuildFile {
  /** Forward-slash path relative to the build root. */
  path: string;
  size: number;
}

export interface Finding {
  /** Stable id an agent can branch on. */
  id: string;
  /** An `error` fails the package; a `warning` is packaged and reported. */
  level: "error" | "warning";
  message: string;
  /** The files it is about, when it is about files. */
  paths?: string[];
}

export interface AuditInput {
  files: BuildFile[];
  /** Contents of one text file in the build. */
  readText: (path: string) => string;
  limits: PortalLimits;
  /** The portal SDK the build must call, when the portal has one this checks. */
  sdk: PortalSdk | null;
}

const TEXT_EXTENSIONS = /\.(?:html?|css|m?js)$/iu;
const MARKUP_EXTENSIONS = /\.(?:html?)$/iu;
const SOURCE_MAP = /\.map$/iu;

const ROOT_ATTRIBUTE = /\b(?:src|href|poster|data|action)\s*=\s*["']\/(?!\/)(?<target>[^"'#?]*)/giu;

const ROOT_LITERAL =
  /(?:["'`]|url\()\/(?!\/)(?<target>[\w@.~-]+(?:\/[\w@.~-]+)*\.[a-z0-9]{2,5})(?=["'`)?#])/giu;

const REMOTE_HOST = /\bhttps?:\/\/(?<host>[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?=[/"'`\s)]|$)/giu;

const INERT_HOSTS = new Set([
  "www.w3.org",
  "github.com",
  "raw.githubusercontent.com",
  "reactjs.org",
  "react.dev",
  "threejs.org",
  "phaser.io",
  "developer.mozilla.org",
  "fb.me",
  "opensource.org",
  "www.apache.org",
  "creativecommons.org",
  "feross.org",
  "jquery.org",
  "vite.dev",
  "vitejs.dev",
]);

const formatBytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const unique = (values: string[]) => [...new Set(values)].toSorted();

const captures = (text: string, pattern: RegExp, group: string) => {
  const found: string[] = [];

  for (const match of text.matchAll(pattern)) {
    const value = match.groups?.[group];

    if (value !== undefined && value.length > 0) {
      found.push(value);
    }
  }

  return found;
};

const rootReferences: (input: AuditInput) => Finding[] = (input) => {
  const shipped = new Set(input.files.map((file) => file.path));
  const offenders = new Map<string, string[]>();

  for (const file of input.files) {
    if (!TEXT_EXTENSIONS.test(file.path)) {
      continue;
    }

    const text = input.readText(file.path);

    const targets = MARKUP_EXTENSIONS.test(file.path)
      ? captures(text, ROOT_ATTRIBUTE, "target")
      : captures(text, ROOT_LITERAL, "target").filter((target) => shipped.has(target));

    if (targets.length > 0) {
      offenders.set(file.path, unique(targets));
    }
  }

  if (offenders.size === 0) {
    return [];
  }

  const examples = [...offenders]
    .flatMap(([file, targets]) => targets.map((target) => `/${target} (in ${file})`))
    .slice(0, 5);

  return [
    {
      id: "root-relative-url",
      level: "error",
      message:
        `The build loads files from the site root (${examples.join(", ")}). ` +
        "A portal serves the game from a folder, where those 404. Build with a relative base " +
        '(Vite: `base: "./"`) and reference files as `./name` or through an import.',
      paths: [...offenders.keys()].toSorted(),
    },
  ];
};

const sizeFindings = ({ files, limits }: AuditInput) => {
  const findings: Finding[] = [];
  const total = files.reduce((sum, file) => sum + file.size, 0);

  if (limits.maxFiles !== null && files.length > limits.maxFiles) {
    findings.push({
      id: "too-many-files",
      level: "error",
      message: `${files.length} files; the portal accepts ${limits.maxFiles}. Pack small assets into atlases or a single data file.`,
    });
  }

  if (limits.maxExtractedBytes !== null && total > limits.maxExtractedBytes) {
    findings.push({
      id: "build-too-large",
      level: "error",
      message: `The build is ${formatBytes(total)} unpacked; the portal accepts ${formatBytes(limits.maxExtractedBytes)}.`,
    });
  }

  const { maxFileBytes } = limits;

  if (maxFileBytes !== null) {
    const oversized = files.filter((file) => file.size > maxFileBytes).map((file) => file.path);

    if (oversized.length > 0) {
      findings.push({
        id: "file-too-large",
        level: "error",
        message: `${oversized.length} file(s) exceed the portal's ${formatBytes(maxFileBytes)} per-file limit.`,
        paths: oversized.toSorted(),
      });
    }
  }

  return findings;
};

const pathFindings = ({ files, limits }: AuditInput) => {
  const findings: Finding[] = [];
  const { maxPathLength } = limits;

  if (maxPathLength !== null) {
    const long = files.filter((file) => file.path.length > maxPathLength).map((file) => file.path);

    if (long.length > 0) {
      findings.push({
        id: "path-too-long",
        level: "error",
        message: `${long.length} path(s) are longer than the portal's ${maxPathLength} characters.`,
        paths: long.toSorted(),
      });
    }
  }

  const byFolded = new Map<string, string[]>();

  for (const file of files) {
    const folded = file.path.toLowerCase();
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), file.path]);
  }

  const collisions = [...byFolded.values()].filter((paths) => paths.length > 1).flat();

  if (collisions.length > 0) {
    findings.push({
      id: "case-collision",
      level: "error",
      message:
        "Paths differ only by letter case. They are one file on a case-insensitive host and two on a case-sensitive one, so one of them loads the wrong thing somewhere.",
      paths: collisions.toSorted(),
    });
  }

  return findings;
};

const fileNameFinding: ({ files, limits }: AuditInput) => Finding[] = ({ files, limits }) => {
  const { fileName } = limits;

  if (fileName === null) {
    return [];
  }

  const bad = files
    .filter((file) => file.path.split("/").some((segment) => !fileName.test(segment)))
    .map((file) => file.path);

  return bad.length === 0
    ? []
    : [
        {
          id: "bad-file-name",
          level: "error",
          message: `${bad.length} path(s) use characters the portal refuses. Rename to letters, digits, "_", "-" and "." only.`,
          paths: bad.toSorted(),
        },
      ];
};

const sdkFinding: ({ files, readText, sdk }: AuditInput) => Finding[] = ({
  files,
  readText,
  sdk,
}) => {
  if (sdk === null) {
    return [];
  }

  const scripts = files
    .filter((file) => TEXT_EXTENSIONS.test(file.path))
    .map((file) => readText(file.path))
    .join("\n");

  const missing = sdk.calls.filter((call) => !scripts.includes(`.${call}(`));

  return missing.length === 0
    ? []
    : [
        {
          id: "sdk-not-called",
          level: "error",
          message: `The build never calls ${missing.join(", ")} from the portal's SDK, which it requires. The distribute skill shows each call.`,
        },
      ];
};

const sourceMapFinding: ({ files }: AuditInput) => Finding[] = ({ files }) => {
  const maps = files.filter((file) => SOURCE_MAP.test(file.path)).map((file) => file.path);

  return maps.length === 0
    ? []
    : [
        {
          id: "source-maps",
          level: "warning",
          message:
            "The build ships source maps: anyone who downloads the game can read its original source. Turn them off for the build you distribute.",
          paths: maps.toSorted(),
        },
      ];
};

/** Third-party hosts the build names — what it will try to reach from a portal's origin. */
export const remoteHosts = (input: Pick<AuditInput, "files" | "readText">) =>
  unique(
    input.files
      .filter((file) => TEXT_EXTENSIONS.test(file.path))
      .flatMap((file) => captures(input.readText(file.path), REMOTE_HOST, "host"))
      .map((host) => host.toLowerCase())
      .filter((host) => !INERT_HOSTS.has(host)),
  );

const remoteHostFinding: (input: AuditInput) => Finding[] = (input) => {
  if (input.limits.network === "open") {
    return [];
  }

  const hosts = remoteHosts(input);

  return hosts.length === 0
    ? []
    : [
        {
          id: "remote-hosts",
          level: "warning",
          message:
            `The build reaches ${hosts.join(", ")}. This portal restricts requests to other hosts: ` +
            "bundle what you can and make the rest optional, so the game still plays when a request is refused.",
        },
      ];
};

export const auditBuild: (input: AuditInput) => Finding[] = (input) => {
  if (!input.files.some((file) => file.path === "index.html")) {
    return [
      {
        id: "no-index",
        level: "error",
        message:
          "No index.html at the build root. Point at the build output (dist/), not the project.",
      },
    ];
  }

  return [
    ...rootReferences(input),
    ...sizeFindings(input),
    ...pathFindings(input),
    ...fileNameFinding(input),
    ...sdkFinding(input),
    ...sourceMapFinding(input),
    ...remoteHostFinding(input),
  ];
};
