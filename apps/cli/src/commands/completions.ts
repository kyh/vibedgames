import { defineCommand } from "citty";

const SUPPORTED = new Set(["bash", "zsh", "fish"]);

const SUBCOMMANDS = [
  "init",
  "login",
  "logout",
  "deploy",
  "asset",
  "image",
  "models",
  "completions",
  "whoami",
];

const IMAGE_SUBCOMMANDS = ["generate", "edit"];
const ASSET_SUBCOMMANDS = ["sprite"];

const COMMON_FLAGS = ["--help", "--version"];

const IMAGE_FLAGS = [
  "--provider",
  "--model",
  "--prompt",
  "--prompt-file",
  "--output",
  "-o",
  "--filename-prefix",
  "--params",
  "--params-file",
  "--image",
  "--reference",
  "--mask",
  "--palette",
  "--count",
  "-n",
  "--concurrency",
  "-p",
  "--json",
  "--quiet",
  "-q",
];

const ASSET_FLAGS = [
  "--video",
  "--character",
  "--animation",
  "--indices",
  "--frames",
  "--notes",
  "--out-dir",
  "--run-dir",
  "--work-dir",
  "--cell-size",
  "--background",
  "--fps",
  "--clear-rect",
  "--overwrite",
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
    image)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${IMAGE_SUBCOMMANDS.join(" ")} ${IMAGE_FLAGS.join(" ")} ${COMMON_FLAGS.join(" ")}" -- "$cur") )
        return
      fi
      COMPREPLY=( $(compgen -W "${IMAGE_FLAGS.join(" ")} ${COMMON_FLAGS.join(" ")}" -- "$cur") )
      return
      ;;
    asset)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${ASSET_SUBCOMMANDS.join(" ")} ${ASSET_FLAGS.join(" ")} ${COMMON_FLAGS.join(" ")}" -- "$cur") )
        return
      fi
      COMPREPLY=( $(compgen -W "${ASSET_FLAGS.join(" ")} ${COMMON_FLAGS.join(" ")}" -- "$cur") )
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
  local -a subcmds image_subs image_flags asset_subs asset_flags common_flags
  subcmds=(${SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})
  image_subs=(${IMAGE_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})
  image_flags=(${IMAGE_FLAGS.map((s) => `"${s}"`).join(" ")})
  asset_subs=(${ASSET_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})
  asset_flags=(${ASSET_FLAGS.map((s) => `"${s}"`).join(" ")})
  common_flags=(${COMMON_FLAGS.map((s) => `"${s}"`).join(" ")})

  if (( CURRENT == 2 )); then
    _values "vg subcommand" "\${subcmds[@]}" "\${common_flags[@]}"
    return
  fi
  case "\${words[2]}" in
    image)
      if (( CURRENT == 3 )); then
        _values "vg image subcommand" "\${image_subs[@]}" "\${image_flags[@]}" "\${common_flags[@]}"
        return
      fi
      _values "vg image flag" "\${image_flags[@]}" "\${common_flags[@]}"
      ;;
    asset)
      if (( CURRENT == 3 )); then
        _values "vg asset subcommand" "\${asset_subs[@]}" "\${asset_flags[@]}" "\${common_flags[@]}"
        return
      fi
      _values "vg asset flag" "\${asset_flags[@]}" "\${common_flags[@]}"
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
  const imageFlagLines = [...IMAGE_FLAGS, ...COMMON_FLAGS].map((flag) =>
    fishFlag(flag, "__fish_seen_subcommand_from image"),
  );
  const assetFlagLines = [...ASSET_FLAGS, ...COMMON_FLAGS].map((flag) =>
    fishFlag(flag, "__fish_seen_subcommand_from asset"),
  );
  // For all other subcommands, only the common flags are meaningful.
  const otherSubcommands = SUBCOMMANDS.filter((s) => s !== "image" && s !== "asset");
  const otherFlagLines = COMMON_FLAGS.flatMap((flag) =>
    otherSubcommands.map((sub) => fishFlag(flag, `__fish_seen_subcommand_from ${sub}`)),
  );
  const topLevelFlagLines = COMMON_FLAGS.map((flag) => fishFlag(flag, "__fish_use_subcommand"));
  return `# vg completions for fish.
complete -c vg -f
complete -c vg -n '__fish_use_subcommand' -a '${SUBCOMMANDS.join(" ")}'
${topLevelFlagLines.join("\n")}
${IMAGE_SUBCOMMANDS.map(
  (sub) => `complete -c vg -n '__fish_seen_subcommand_from image' -a '${sub}'`,
).join("\n")}
${ASSET_SUBCOMMANDS.map(
  (sub) => `complete -c vg -n '__fish_seen_subcommand_from asset' -a '${sub}'`,
).join("\n")}
${imageFlagLines.join("\n")}
${assetFlagLines.join("\n")}
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
