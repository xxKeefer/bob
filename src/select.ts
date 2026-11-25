export interface Selection {
  id: string | undefined;
  index: number;
}

export const START: Selection = { id: undefined, index: 0 };

export function reconcile(selection: Selection, ids: string[]): Selection {
  if (ids.length === 0) return START;

  const found = selection.id === undefined ? -1 : ids.indexOf(selection.id);
  const index = found === -1 ? Math.min(selection.index, ids.length - 1) : found;

  return { id: ids[index], index };
}

export function move(selection: Selection, ids: string[], delta: number): Selection {
  const current = reconcile(selection, ids);

  if (ids.length === 0) return current;

  const index = Math.max(0, Math.min(ids.length - 1, current.index + delta));

  return { id: ids[index], index };
}
