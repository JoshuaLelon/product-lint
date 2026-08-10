/**
 * A path list rendered as a directory tree.
 *
 * A flat list of 317 paths is a wall an agent skims and a person scrolls past.
 * The same paths as a tree show where the work actually is: one directory with
 * 77 ungoverned files is a different problem from 77 directories with one each,
 * and the flat list hides which one you have.
 *
 * Two modes, because the useful answer changes with size. A short list wants the
 * file names. A long list wants the shape — naming eight files out of 317 tells
 * you almost nothing, while "src/components holds 77 of them" tells you where to
 * start and what one Mechanism node could cover.
 *
 * Every limit here is announced in the output. A tree that silently stops at 40
 * lines reads as "that is all of it", which is the failure this file exists to
 * avoid.
 */

interface Node {
  children: Map<string, Node>;
  files: string[];
}

function emptyNode(): Node {
  return { children: new Map(), files: [] };
}

function plural(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export interface TreeOptions {
  /** Above this many paths, render directory counts instead of file names. */
  summarizeAbove?: number;
  /** Files listed per directory, when listing names. */
  filesPerDirectory?: number;
  /** Total lines of tree before the rest are counted instead. */
  maxLines?: number;
}

function insert(root: Node, filePath: string): void {
  const segments = filePath.split("/").filter(Boolean);
  const name = segments.pop();
  if (!name) return;
  let node = root;
  for (const segment of segments) {
    let next = node.children.get(segment);
    if (!next) {
      next = emptyNode();
      node.children.set(segment, next);
    }
    node = next;
  }
  node.files.push(name);
}

/**
 * A directory with one subdirectory and no files of its own is joined to it, so
 * `src/store/slices/` is one row rather than three. The intermediate rows carry
 * no information a reader does not already have from the joined path.
 */
function collapse(name: string, node: Node): { name: string; node: Node } {
  let label = name;
  let current = node;
  while (current.files.length === 0 && current.children.size === 1) {
    const [childName, childNode] = [...current.children.entries()][0]!;
    label = `${label}/${childName}`;
    current = childNode;
  }
  return { name: label, node: current };
}

/** Every file at or below this node. */
function totalFiles(node: Node): number {
  let total = node.files.length;
  for (const child of node.children.values()) total += totalFiles(child);
  return total;
}

function sortedChildren(node: Node): Array<{ name: string; node: Node }> {
  return [...node.children.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([childName, childNode]) => collapse(childName, childNode));
}

export function renderTree(paths: string[], options: TreeOptions = {}): string {
  const summarizeAbove = options.summarizeAbove ?? 30;
  const filesPerDirectory = options.filesPerDirectory ?? 8;
  const maxLines = options.maxLines ?? 40;
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) return "";

  const root = emptyNode();
  for (const entry of unique) insert(root, entry);

  const lines: string[] = [];
  const summarize = unique.length > summarizeAbove;

  const walk = (node: Node, depth: number): void => {
    const indent = "  ".repeat(depth);
    for (const child of sortedChildren(node)) {
      if (summarize) {
        const own = child.node.files.length;
        const all = totalFiles(child.node);
        // The directory's own count is what a Mechanism node would have to own.
        // The subtree count is what the branch costs in total, and they differ
        // whenever the work is really one level further down.
        const detail = own === all ? plural(all) : `${plural(all)}, ${own} here`;
        lines.push(`${indent}${child.name}/  ${detail}`);
        walk(child.node, depth + 1);
        continue;
      }
      lines.push(`${indent}${child.name}/`);
      walk(child.node, depth + 1);
    }
    if (summarize) return;
    const shown = node.files.slice(0, filesPerDirectory);
    for (const file of shown) lines.push(`${indent}${file}`);
    const hidden = node.files.length - shown.length;
    if (hidden > 0) {
      lines.push(`${indent}... and ${hidden} more ${hidden === 1 ? "file" : "files"} in this directory`);
    }
  };

  walk(root, 0);

  const header = summarize ? ["(by directory, because the list is long)"] : [];

  if (lines.length > maxLines) {
    const dropped = lines.length - maxLines;
    return [
      ...header,
      ...lines.slice(0, maxLines),
      `... and ${dropped} more line(s) not shown`,
    ].join("\n");
  }
  return [...header, ...lines].join("\n");
}
