export type FileNode = {
  name: string;
  path: string;
  isFolder: boolean;
  children?: string[];
};

const ROOT_ID = ".";

// Convert file paths into a flat tree structure
export function buildFileTree(
  files: Record<string, string>,
): Record<string, FileNode> {
  const tree: Record<string, FileNode> = {};
  const rootChildren = new Set<string>();

  // Process each file path
  for (const filePath of Object.keys(files)) {
    // Normalize path: remove leading slash and split into parts
    const normalizedPath = filePath.startsWith("/")
      ? filePath.slice(1)
      : filePath;
    const parts = normalizedPath.split("/").filter(Boolean);

    if (parts.length === 0) continue;

    let parentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const currentPath = parentPath ? `${parentPath}/${part}` : part;
      const isFile = i === parts.length - 1;

      // Create node if it doesn't exist
      if (!(currentPath in tree)) {
        tree[currentPath] = {
          name: part,
          path: currentPath,
          isFolder: !isFile,
          children: !isFile ? [] : undefined,
        };

        // Track root-level items
        if (!parentPath) {
          rootChildren.add(currentPath);
        }
      }

      // Add to parent's children if parent exists
      if (parentPath) {
        const parent = tree[parentPath];
        if (parent?.children) {
          const children = parent.children;
          if (!children.includes(currentPath)) {
            children.push(currentPath);
          }
        }
      }

      parentPath = currentPath;
    }
  }

  // Create root node
  tree[ROOT_ID] = {
    name: "root",
    path: ROOT_ID,
    isFolder: true,
    children: Array.from(rootChildren),
  };

  return tree;
}
