import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useState, type FormEvent } from "react";
import type { Project } from "../../shared/types";
import { DirectoryInput } from "./DirectoryInput";

interface ProjectPickerProps {
  projects: Project[] | null;
  error: string | null;
  onRetry: () => void;
  onOpen: (path: string) => Promise<void>;
  onSelect: (projectId: string) => void;
}

export function ProjectPicker({ projects, error, onRetry, onOpen, onSelect }: ProjectPickerProps) {
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!path.trim() || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      await onOpen(path.trim());
      setPath("");
    } catch (err) {
      setOpenError(String(err));
    } finally {
      setOpening(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto grid max-w-3xl gap-4 text-sm">
        <h1 className="text-xl font-semibold">Projects</h1>
        <form onSubmit={(event) => void submit(event)} className="grid gap-3 rounded-lg bg-kumo-elevated px-5 py-4 ring ring-kumo-line">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <DirectoryInput
              value={path}
              onValueChange={setPath}
              invalid={openError !== null}
              disabled={opening}
            />
            <Button type="submit" variant="primary" className="shrink-0 text-sm" loading={opening} disabled={!path.trim() || opening}>Open project</Button>
          </div>
          {openError && <p role="alert" className="break-words text-kumo-danger">{openError}</p>}
        </form>
        <section aria-labelledby="recent-projects" className="mt-4 grid gap-3">
          <h2 id="recent-projects" className="text-lg font-semibold">Recent projects</h2>
          {error && (
            <div role="alert" className="grid gap-2">
              <p className="break-words text-kumo-danger">Could not load projects. {error}</p>
              <Button variant="secondary" className="justify-self-start text-sm" onClick={onRetry}>Retry</Button>
            </div>
          )}
          {projects === null && !error && <div role="status" className="flex items-center gap-2"><Loader />Loading projects…</div>}
          {projects?.length === 0 && <p className="text-kumo-subtle">No projects yet. Open a working tree above or run <code className="font-mono text-[0.9em]">diffreview open /path/to/project</code>.</p>}
          <ul className="grid gap-2">
            {projects?.map((project) => (
              <li key={project.id}>
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start rounded-lg px-4 py-3 text-left text-sm ring ring-kumo-line"
                  onClick={() => onSelect(project.id)}
                  aria-label={`Open ${project.name}, ${project.root}`}
                >
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="font-medium">{project.name}</span>
                    <span className="break-all font-mono text-[0.9em] text-kumo-subtle">{project.root}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
