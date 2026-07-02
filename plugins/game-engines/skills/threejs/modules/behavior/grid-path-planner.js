function cloneCell(cell) {
  return {
    right: Math.floor(cell.right),
    forward: Math.floor(cell.forward),
  };
}

export function gridCellKey(cell) {
  return `${Math.floor(cell.right)}:${Math.floor(cell.forward)}`;
}

export function normalizeBlockedCells(blocked = []) {
  if (blocked instanceof Set) return new Set(blocked);
  const keys = new Set();
  for (const cell of blocked ?? []) {
    if (!cell) continue;
    if (typeof cell === "string") {
      keys.add(cell);
    } else {
      keys.add(gridCellKey(cell));
    }
  }
  return keys;
}

function wrapDelta(delta, size) {
  return Math.min(Math.abs(delta), size - Math.abs(delta));
}

function priorityInsert(open, entry) {
  let index = open.length;
  while (index > 0 && open[index - 1].f > entry.f) {
    index -= 1;
  }
  open.splice(index, 0, entry);
}

function stepCell(cell, direction, board, wrap, navigation) {
  const vector = navigation.vectors[direction];
  const next = {
    right: cell.right + vector.right,
    forward: cell.forward + vector.forward,
  };

  if (wrap) {
    if (next.right < 0) next.right = board.columns - 1;
    if (next.right >= board.columns) next.right = 0;
    if (next.forward < 0) next.forward = board.rows - 1;
    if (next.forward >= board.rows) next.forward = 0;
    return next;
  }

  if (
    next.right < 0 ||
    next.right >= board.columns ||
    next.forward < 0 ||
    next.forward >= board.rows
  ) {
    return null;
  }

  return next;
}

// Cell coordinates use planar basis naming: right = column axis, forward = row axis.
export const FOUR_WAY_GRID_NAVIGATION = Object.freeze({
  vectors: Object.freeze({
    forward: Object.freeze({ right: 0, forward: 1 }),
    backward: Object.freeze({ right: 0, forward: -1 }),
    left: Object.freeze({ right: -1, forward: 0 }),
    right: Object.freeze({ right: 1, forward: 0 }),
  }),
  neighborOrder: Object.freeze(["forward", "right", "backward", "left"]),
});

export class GridPathPlanner {
  constructor({
    navigation = FOUR_WAY_GRID_NAVIGATION,
    columns = 20,
    rows = 20,
    wrap = true,
    neighborOrder = null,
  }) {
    this.navigation = navigation;
    this.columns = Math.floor(columns);
    this.rows = Math.floor(rows);
    this.wrap = wrap !== false;
    this.neighborOrder = [...(neighborOrder ?? this.navigation.neighborOrder)];
  }

  setBoard(columns = this.columns, rows = this.rows, wrap = this.wrap) {
    this.columns = Math.floor(columns);
    this.rows = Math.floor(rows);
    this.wrap = wrap !== false;
    return this;
  }

  heuristic(a, b) {
    const dRight = this.wrap
      ? wrapDelta(a.right - b.right, this.columns)
      : Math.abs(a.right - b.right);
    const dForward = this.wrap
      ? wrapDelta(a.forward - b.forward, this.rows)
      : Math.abs(a.forward - b.forward);
    return dRight + dForward;
  }

  getNeighbors(cell, wrap = this.wrap) {
    const neighbors = [];
    for (const direction of this.neighborOrder) {
      const next = stepCell(cell, direction, this, wrap, this.navigation);
      if (!next) continue;
      neighbors.push({
        cell: next,
        direction,
      });
    }
    return neighbors;
  }

  findPath(
    start,
    goal,
    blocked = [],
    allowStartOccupied = true,
    allowGoalOccupied = true,
    wrap = this.wrap,
  ) {
    if (!start || !goal) return null;

    const startCell = cloneCell(start);
    const goalCell = cloneCell(goal);
    const startKey = gridCellKey(startCell);
    const goalKey = gridCellKey(goalCell);
    const blockedKeys = normalizeBlockedCells(blocked);
    if (allowStartOccupied) blockedKeys.delete(startKey);
    if (allowGoalOccupied) blockedKeys.delete(goalKey);

    if (startKey === goalKey) {
      return [startCell];
    }

    const open = [];
    const cameFrom = new Map();
    const costSoFar = new Map();

    costSoFar.set(startKey, 0);
    priorityInsert(open, {
      key: startKey,
      cell: startCell,
      f: this.heuristic(startCell, goalCell),
    });

    while (open.length > 0) {
      const current = open.shift();
      if (current.key === goalKey) {
        const path = [goalCell];
        let cursorKey = goalKey;
        while (cursorKey !== startKey) {
          const prev = cameFrom.get(cursorKey);
          if (!prev) return null;
          path.push(prev.cell);
          cursorKey = prev.key;
        }
        path.reverse();
        return path;
      }

      const currentCost = costSoFar.get(current.key) ?? 0;
      for (const neighbor of this.getNeighbors(current.cell, wrap)) {
        const neighborKey = gridCellKey(neighbor.cell);
        if (blockedKeys.has(neighborKey)) continue;

        const nextCost = currentCost + 1;
        if (nextCost >= (costSoFar.get(neighborKey) ?? Infinity)) continue;

        costSoFar.set(neighborKey, nextCost);
        cameFrom.set(neighborKey, {
          key: current.key,
          cell: current.cell,
          direction: neighbor.direction,
        });
        priorityInsert(open, {
          key: neighborKey,
          cell: neighbor.cell,
          f: nextCost + this.heuristic(neighbor.cell, goalCell),
        });
      }
    }

    return null;
  }

  floodFill(start, blocked = [], allowStartOccupied = true, wrap = this.wrap, limit = Infinity) {
    if (!start) {
      return { count: 0, cells: [] };
    }

    const startCell = cloneCell(start);
    const startKey = gridCellKey(startCell);
    const blockedKeys = normalizeBlockedCells(blocked);
    if (allowStartOccupied) blockedKeys.delete(startKey);

    if (blockedKeys.has(startKey)) {
      return { count: 0, cells: [] };
    }

    const queue = [startCell];
    const seen = new Set([startKey]);
    const cells = [];

    while (queue.length > 0) {
      const current = queue.shift();
      cells.push(current);
      if (cells.length >= limit) break;

      for (const neighbor of this.getNeighbors(current, wrap)) {
        const neighborKey = gridCellKey(neighbor.cell);
        if (seen.has(neighborKey) || blockedKeys.has(neighborKey)) continue;
        seen.add(neighborKey);
        queue.push(neighbor.cell);
      }
    }

    return {
      count: cells.length,
      cells,
    };
  }
}
