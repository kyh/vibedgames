import { defineCommand } from "citty";

const SUPPORTED = new Set(["bash", "zsh", "fish"]);

const SUBCOMMANDS = [
  "init",
  "login",
  "logout",
  "deploy",
  "media",
  "completions",
  "whoami",
];

const MEDIA_SUBCOMMANDS = ["run", "status", "models", "schema", "pricing", "docs", "upload"];

const COMMON_FLAGS = ["--help", "--version"];

// CLI-level flags across the media subcommands. Model parameters are
// arbitrary per fal endpoint and passed as `--<param>`, so they can't be
// enumerated here — these are just the stable, command-defined flags.
const MEDIA_FLAGS = [
  "--async",
  "--download",
  "--result",
  "--cancel",
  "--logs",
  "--category",
  "--status",
  "--limit",
  "--cursor",
  "--endpoint_id",
  "--expand",
  "--format",
  "--json",
  "--quiet",
];

function bashScript(): string {
  return `# vg completions for bash. Source this file or write it to a file in your
# bash completion directory (e.g. /etc/bash_completion.d/vg).
_vg_completions() {
  local cur prev cmd subcmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  subcmd="\${COMP_WORDS[2]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS.join(" ")} ${COMMON_FLAGS.join(" ")}" -- "$cur") )
    return
  fi

  case "$cmd" in
    media)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${MEDIA_SUBCOMMANDS.join(" ")} ${MEDIA_FLAGS.join(" ")} ${COMMON_FLAGS.join(" ")}" -- "$cur") )
        return
      fi
      COMPREPLY=( $(compgen -W "${MEDIA_FLAGS.join(" ")} ${COMMON_FLAGS.join(" ")}" -- "$cur") )
      return
      ;;
    *)
      COMPREPLY=( $(compgen -W "${COMMON_FLAGS.join(" ")}" -- "$cur") )
      return
      ;;
  esac
}
complete -F _vg_completions vg
`;
}

function zshScript(): string {
  return `# vg completions for zsh. Source this file or place it on your fpath.
_vg() {
  local -a subcmds media_subs media_flags common_flags
  subcmds=(${SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})
  media_subs=(${MEDIA_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})
  media_flags=(${MEDIA_FLAGS.map((s) => `"${s}"`).join(" ")})
  common_flags=(${COMMON_FLAGS.map((s) => `"${s}"`).join(" ")})

  if (( CURRENT == 2 )); then
    _values "vg subcommand" "\${subcmds[@]}" "\${common_flags[@]}"
    return
  fi
  case "\${words[2]}" in
    media)
      if (( CURRENT == 3 )); then
        _values "vg media subcommand" "\${media_subs[@]}" "\${media_flags[@]}" "\${common_flags[@]}"
        return
      fi
      _values "vg media flag" "\${media_flags[@]}" "\${common_flags[@]}"
      ;;
    *)
      _values "vg flag" "\${common_flags[@]}"
      ;;
  esac
}
compdef _vg vg
`;
}

function fishFlag(flag: string, condition: string): string {
  const isShort = flag.startsWith("-") && !flag.startsWith("--");
  const name = flag.replace(/^--?/, "");
  const opt = isShort ? "-s" : "-l";
  return `complete -c vg -n '${condition}' ${opt} '${name}'`;
}

function fishScript(): string {
  const mediaFlagLines = [...MEDIA_FLAGS, ...COMMON_FLAGS].map((flag) =>
    fishFlag(flag, "__fish_seen_subcommand_from media"),
  );
  // For all other subcommands, only the common flags are meaningful.
  const otherSubcommands = SUBCOMMANDS.filter((s) => s !== "media");
  const otherFlagLines = COMMON_FLAGS.flatMap((flag) =>
    otherSubcommands.map((sub) => fishFlag(flag, `__fish_seen_subcommand_from ${sub}`)),
  );
  const topLevelFlagLines = COMMON_FLAGS.map((flag) => fishFlag(flag, "__fish_use_subcommand"));
  return `# vg completions for fish.
complete -c vg -f
complete -c vg -n '__fish_use_subcommand' -a '${SUBCOMMANDS.join(" ")}'
${topLevelFlagLines.join("\n")}
${MEDIA_SUBCOMMANDS.map(
  (sub) => `complete -c vg -n '__fish_seen_subcommand_from media' -a '${sub}'`,
).join("\n")}
${mediaFlagLines.join("\n")}
${otherFlagLines.join("\n")}
`;
}

export const completionsCommand = defineCommand({
  meta: {
    name: "completions",
    description: "Print shell completions for vg. Pipe into your shell's completion dir.",
  },
  args: {
    shell: {
      type: "positional",
      description: "Shell to generate completions for: bash | zsh | fish",
      required: true,
    },
  },
  run: ({ args }) => {
    const shell = String(args.shell ?? "");
    if (!SUPPORTED.has(shell)) {
      process.stderr.write(
        `Unsupported shell "${shell}". Expected: ${Array.from(SUPPORTED).join(", ")}\n`,
      );
      process.exit(1);
    }
    const script = shell === "bash" ? bashScript() : shell === "zsh" ? zshScript() : fishScript();
    process.stdout.write(script);
  },
});
