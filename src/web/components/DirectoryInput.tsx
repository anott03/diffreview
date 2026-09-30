import { Combobox } from "@cloudflare/kumo/components/combobox";
import { inputVariants } from "@cloudflare/kumo/components/input";
import { FolderIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { globalApi } from "../api";

interface DirectoryInputProps {
  value: string;
  onValueChange: (path: string) => void;
  disabled: boolean;
  invalid: boolean;
}

interface DirectorySuggestions {
  path: string;
  directories: string[];
  error: boolean;
}

export function DirectoryInput({ value, onValueChange, disabled, invalid }: DirectoryInputProps) {
  const [requestedOpen, setRequestedOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<DirectorySuggestions | null>(null);
  const open = requestedOpen && value.length > 0 && !disabled;
  const current = suggestions?.path === value ? suggestions : null;
  const directories = current?.directories ?? [];

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void globalApi.getDirectories(value, controller.signal).then(({ directories }) => {
        if (!controller.signal.aborted) setSuggestions({ path: value, directories, error: false });
      }).catch(() => {
        if (!controller.signal.aborted) setSuggestions({ path: value, directories: [], error: true });
      });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value, open]);

  return (
    <div className="min-w-0 flex-1">
      <Combobox
        items={directories}
        filter={null}
        value={null}
        inputValue={value}
        onInputValueChange={(path, details) => {
          if (details.reason === "input-change" || details.reason === "input-clear") onValueChange(path);
        }}
        onValueChange={(directory) => {
          if (directory !== null) onValueChange(directory);
        }}
        open={open}
        onOpenChange={(nextOpen, details) => {
          if (details.reason === "item-press") details.cancel();
          else setRequestedOpen(nextOpen);
        }}
        disabled={disabled}
        autoComplete="off"
      >
        <Combobox.Input
          id="project-path"
          aria-label="Working-tree path"
          aria-invalid={invalid}
          className={`${inputVariants({ variant: invalid ? "error" : "default" })} mx-0 w-full text-sm first:mb-0`}
          placeholder="/home/you/project"
          required
          spellCheck={false}
        />
        <Combobox.Content>
          <Combobox.List>
            {directories.map((directory) => (
              <Combobox.Item key={directory} value={directory} className="text-sm" aria-label={directory}>
                <span className="flex min-w-0 items-center gap-2">
                  <FolderIcon size={16} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
                  <span className="truncate">{directory.split(/[\\/]/).filter(Boolean).at(-1)}/</span>
                </span>
              </Combobox.Item>
            ))}
          </Combobox.List>
          {directories.length === 0 && (
            <p role="status" className="px-3 py-2 text-sm text-kumo-subtle">
              {!current ? "Loading directories…" : current.error ? "Could not load directories." : "No matching directories."}
            </p>
          )}
        </Combobox.Content>
      </Combobox>
    </div>
  );
}
