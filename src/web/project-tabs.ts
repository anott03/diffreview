import { z } from "zod";

const SavedTabsSchema = z.object({
  ids: z.array(z.string().min(1)),
  activeId: z.string().min(1).nullable(),
});

export type ProjectTabsState = z.infer<typeof SavedTabsSchema>;

export function projectUrl(projectId: string | null): string {
  return projectId === null ? "/" : `/projects/${encodeURIComponent(projectId)}`;
}

export function projectFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

export function activateProject(state: ProjectTabsState, projectId: string | null): ProjectTabsState {
  return {
    ids: projectId === null || state.ids.includes(projectId) ? state.ids : [...state.ids, projectId],
    activeId: projectId,
  };
}

export function closeProject(state: ProjectTabsState, projectId: string): ProjectTabsState {
  const index = state.ids.indexOf(projectId);
  const ids = state.ids.filter((id) => id !== projectId);
  return {
    ids,
    activeId: state.activeId === projectId ? (ids[Math.min(index, ids.length - 1)] ?? null) : state.activeId,
  };
}

export function restoreProjectTabs(pathname: string, saved: string | null): ProjectTabsState {
  let state: ProjectTabsState = { ids: [], activeId: null };
  try {
    const parsed = SavedTabsSchema.safeParse(JSON.parse(saved ?? "null"));
    if (parsed.success) {
      state = activateProject({ ids: [...new Set(parsed.data.ids)], activeId: null }, parsed.data.activeId);
    }
  } catch {
    // Invalid saved tabs do not prevent opening a direct project URL.
  }
  const direct = projectFromPath(pathname);
  return direct !== null ? activateProject(state, direct) : pathname === "/" ? state : { ...state, activeId: null };
}

export function reconcileProjectTabs(state: ProjectTabsState, knownIds: Set<string>): ProjectTabsState {
  return { ...state, ids: state.ids.filter((id) => id === state.activeId || knownIds.has(id)) };
}
