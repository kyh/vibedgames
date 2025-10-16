export type FileNode = {
  children?: FileNode[];
  content?: string;
  expanded?: boolean;
  name: string;
  path: string;
  type: "file" | "folder";
};

type FileNodeBuilder = {
  children?: Record<string, FileNodeBuilder>;
  content?: string;
  expanded?: boolean;
  name: string;
  path: string;
  type: "file" | "folder";
};

export function buildFileTree(paths: string[]): FileNode[] {
  if (paths.length === 0) return [];
  const root: Record<string, FileNodeBuilder> = {};

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let current: Record<string, FileNodeBuilder> = root;
    let currentPath = "";

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part) continue;

      currentPath += "/" + part;
      const isFile = index === parts.length - 1;

      if (!(part in current)) {
        current[part] = {
          name: part,
          type: isFile ? "file" : "folder",
          path: currentPath,
          content: isFile
            ? `// Content for ${currentPath}\n// This will be loaded when the file is selected`
            : undefined,
          children: isFile ? undefined : {},
          expanded: false,
        };
      }

      if (!isFile) {
        const node = current[part];
        if (node?.children) {
          current = node.children;
        }
      }
    }
  }

  const convertToArray = (obj: Record<string, FileNodeBuilder>): FileNode[] => {
    return Object.values(obj)
      .map(
        (node): FileNode => ({
          ...node,
          children: node.children ? convertToArray(node.children) : undefined,
        }),
      )
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  };

  return convertToArray(root);
}
