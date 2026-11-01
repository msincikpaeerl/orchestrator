/**
 * Depth of each ticket in a dependency graph (02, sections 5.3 and 6.3; owner's answer 6, lot 5
 * step H): 1 for a ticket that waits for nothing in the graph, else 1 plus the depth of its
 * deepest blocker. A blocker that is not in the graph is ignored.
 */
export interface DependencyNode {
  id: string;
  /** The ids of the tickets it waits for. */
  waitsFor: readonly string[];
}

export interface DependencyLayers {
  /** Column `i` holds the ids of depth `i + 1`, in the order the nodes were given. */
  columns: string[][];
  /**
   * Tickets in a cycle, or waiting for one: the server refuses cycles, so this stays empty, but
   * the page shows them in a last column instead of hanging ("Waits in a loop").
   */
  loop: string[];
}

export function dependencyLayers(nodes: readonly DependencyNode[]): DependencyLayers {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // undefined: not seen; 'visiting': on the current path; a number: its depth; null: a loop.
  const depths = new Map<string, number | null | 'visiting'>();

  function depthOf(id: string): number | null {
    const known = depths.get(id);
    if (known === 'visiting') return null;
    if (known !== undefined) return known;
    depths.set(id, 'visiting');
    let depth: number | null = 1;
    for (const blocker of byId.get(id)?.waitsFor ?? []) {
      if (!byId.has(blocker)) continue;
      const below = depthOf(blocker);
      if (below === null) depth = null;
      else if (depth !== null) depth = Math.max(depth, below + 1);
    }
    // A blocker still on the path closes a loop: every node on the way back is in it, or waits
    // for it, so a depth is only ever set when every blocker has one.
    depths.set(id, depth);
    return depth;
  }

  const columns: string[][] = [];
  const loop: string[] = [];
  for (const node of nodes) {
    const depth = depthOf(node.id);
    if (depth === null) {
      loop.push(node.id);
      continue;
    }
    while (columns.length < depth) columns.push([]);
    columns[depth - 1]?.push(node.id);
  }
  return { columns, loop };
}
