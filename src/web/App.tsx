import { Button } from "@cloudflare/kumo/components/button";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Project } from "../shared/types";
import { globalApi, useServerEvents } from "./api";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ProjectPicker } from "./components/ProjectPicker";
import { ThemeToggle } from "./components/ThemeToggle";
import { activateProject, closeProject, projectFromPath, projectUrl, reconcileProjectTabs, restoreProjectTabs } from "./project-tabs";

const TABS_STORAGE_KEY = "diffreview-project-tabs";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Browsers can disable storage without disabling the workspace.
  }
}

function initialSidebarWidth(): number {
  const saved = readStorage("diffreview-sidebar-width");
  const width = saved === null ? 260 : Number(saved);
  return Number.isFinite(width) ? Math.min(600, Math.max(200, width)) : 260;
}

export function App() {
  const [tabs, setTabs] = useState(() => restoreProjectTabs(window.location.pathname, readStorage(TABS_STORAGE_KEY)));
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = readStorage("diffreview-sidebar");
    return saved === null ? window.matchMedia("(min-width: 768px)").matches : saved !== "false";
  });
  const tabButtons = useRef(new Map<string | null, HTMLButtonElement>());
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);

  const refreshProjects = useCallback(async () => {
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    try {
      const result = await globalApi.getProjects(controller.signal);
      if (controller.signal.aborted) return;
      setProjects([...result.projects].sort((a, b) => b.openedAt - a.openedAt));
      setCatalogError(null);
      setTabs((previous) => reconcileProjectTabs(previous, new Set(result.projects.map((project) => project.id))));
    } catch (err) {
      if (!controller.signal.aborted) setCatalogError(String(err));
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
    return () => catalogRequest.current?.abort();
  }, [refreshProjects]);

  useServerEvents({
    onProject: (projectId) => setRevisions((previous) => ({ ...previous, [projectId]: (previous[projectId] ?? 0) + 1 })),
    onProjects: () => void refreshProjects(),
    onConnect: () => {
      setConnection("connected");
      setConnectionVersion((version) => version + 1);
      void refreshProjects();
    },
    onDisconnect: () => setConnection("disconnected"),
  });

  useEffect(() => {
    window.history.replaceState(null, "", projectUrl(tabsRef.current.activeId));
    const onPopState = () => {
      const projectId = projectFromPath(window.location.pathname);
      setTabs((previous) => activateProject(previous, projectId));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => saveStorage(TABS_STORAGE_KEY, JSON.stringify(tabs)), [tabs]);
  useEffect(() => saveStorage("diffreview-sidebar", String(sidebarOpen)), [sidebarOpen]);
  useEffect(() => saveStorage("diffreview-sidebar-width", String(sidebarWidth)), [sidebarWidth]);

  useEffect(() => {
    const button = tabButtons.current.get(tabs.activeId);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.activeId]);

  const currentProject = projects?.find((project) => project.id === tabs.activeId);
  useEffect(() => {
    document.title = tabs.activeId === null ? "Projects · diffreview" : `${currentProject?.name ?? "Project"} · diffreview`;
  }, [currentProject?.name, tabs.activeId]);

  const navigate = (projectId: string | null) => {
    setTabs((previous) => activateProject(previous, projectId));
    if (window.location.pathname !== projectUrl(projectId)) window.history.pushState(null, "", projectUrl(projectId));
  };

  const close = (projectId: string) => {
    const next = closeProject(tabsRef.current, projectId);
    setTabs(next);
    if (next.activeId !== tabsRef.current.activeId) window.history.pushState(null, "", projectUrl(next.activeId));
    requestAnimationFrame(() => tabButtons.current.get(next.activeId)?.focus());
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, projectId: string | null) => {
    const ids = [null, ...tabs.ids];
    const index = ids.indexOf(projectId);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % ids.length;
    else if (event.key === "ArrowLeft") next = (index + ids.length - 1) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else if (event.key === "Delete" && projectId !== null) {
      event.preventDefault();
      close(projectId);
      return;
    } else return;
    event.preventDefault();
    const nextId = ids[next] ?? null;
    navigate(nextId);
    tabButtons.current.get(nextId)?.focus();
  };

  const openProject = async (path: string) => {
    const project = await globalApi.openProject(path);
    setProjects((previous) => [project, ...(previous ?? []).filter((item) => item.id !== project.id)]);
    if (tabsRef.current.activeId === null) navigate(project.id);
    else setTabs((previous) => ({ ...activateProject(previous, project.id), activeId: previous.activeId }));
    void refreshProjects();
  };

  return (
    <div className="flex h-full min-w-0 flex-col text-sm">
      <header className="flex shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-4 py-1">
        <span className="shrink-0 font-semibold">diffreview</span>
        <div role="tablist" aria-label="Projects" aria-orientation="horizontal" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <Button
          id="project-tab-home"
          role="tab"
          aria-selected={tabs.activeId === null}
          aria-controls="project-panel-home"
          tabIndex={tabs.activeId === null ? 0 : -1}
          ref={(element) => { if (element) tabButtons.current.set(null, element); else tabButtons.current.delete(null); }}
          variant="ghost"
          className={`shrink-0 rounded-lg px-3 py-1 text-sm h-7 ${tabs.activeId === null ? "ring ring-inset ring-kumo-line [[data-mode=light]_&]:bg-kumo-fill [[data-mode=light]_&]:hover:bg-kumo-fill [[data-mode=light]_&]:ring-kumo-interact" : ""}`}
          icon={PlusIcon}
          onClick={() => navigate(null)}
          onKeyDown={(event) => handleTabKey(event, null)}
        >Projects</Button>
        {tabs.ids.map((id) => {
          const project = projects?.find((item) => item.id === id);
          const selected = tabs.activeId === id;
          const name = project?.name ?? (projects === null ? "Loading project…" : "Unavailable project");
          return (
            <div key={id} role="presentation" className={`group/tab flex w-52 shrink-0 items-center rounded-lg ${selected ? "bg-kumo-tint ring ring-inset ring-kumo-line [[data-mode=light]_&]:bg-kumo-fill [[data-mode=light]_&]:ring-kumo-interact" : "hover:bg-kumo-tint focus-within:bg-kumo-tint"}`}>
              <Button
                id={`project-tab-${id}`}
                role="tab"
                aria-selected={selected}
                aria-controls={`project-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                ref={(element) => { if (element) tabButtons.current.set(id, element); else tabButtons.current.delete(id); }}
                variant="ghost"
                className="h-7 min-w-0 flex-1 justify-start text-left text-sm hover:bg-transparent group-focus-visible:ring-2"
                title={project?.root ?? id}
                aria-label={project ? `${project.name}, ${project.root}` : `${name}, ${id}`}
                onClick={() => navigate(id)}
                onKeyDown={(event) => handleTabKey(event, id)}
              ><span className="min-w-0 flex-1 truncate [mask-image:linear-gradient(to_right,black_75%,transparent_100%)]">{name}</span></Button>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={XIcon}
                className="shrink-0 hidden group-hover/tab:block group-focus-within/tab:block"
                tabIndex={selected ? 0 : -1}
                aria-label={`Close ${project?.name ?? id} tab`}
                title="Close tab. Project history is kept."
                onClick={() => close(id)}
              />
            </div>
          );
        })}
        </div>
        <span role="status" className="shrink-0 text-kumo-subtle">
          {connection === "disconnected" ? "Reconnecting…" : connection === "connecting" ? "Connecting…" : ""}
        </span>
        <div ref={setToolbarContainer} className="contents" />
        <ThemeToggle />
      </header>
      <Sidebar.Provider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        resizable
        defaultWidth={sidebarWidth}
        minWidth={200}
        maxWidth={600}
        onWidthChange={setSidebarWidth}
        contained
        mobileBreakpoint={0}
        className="min-h-0 min-w-0 flex-1"
      >
        <div className="min-h-0 min-w-0 flex-1">
          <div id="project-panel-home" role="tabpanel" aria-labelledby="project-tab-home" tabIndex={0} hidden={tabs.activeId !== null} inert={tabs.activeId !== null} className={tabs.activeId === null ? "h-full" : "hidden"}>
            <ProjectPicker projects={projects} error={catalogError} onRetry={() => void refreshProjects()} onOpen={openProject} onSelect={navigate} />
          </div>
          {tabs.ids.map((id) => (
            <div key={id} id={`project-panel-${id}`} role="tabpanel" aria-labelledby={`project-tab-${id}`} tabIndex={0} hidden={tabs.activeId !== id} inert={tabs.activeId !== id} className={tabs.activeId === id ? "h-full min-w-0" : "hidden"}>
              <ProjectWorkspace projectId={id} active={tabs.activeId === id} revision={revisions[id] ?? 0} connectionVersion={connectionVersion} toolbarContainer={toolbarContainer} />
            </div>
          ))}
        </div>
      </Sidebar.Provider>
    </div>
  );
}
