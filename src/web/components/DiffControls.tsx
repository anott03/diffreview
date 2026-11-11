import { Button } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import type { Layout } from "./DiffView";

interface DiffControlsProps {
  layout: Layout;
  onLayoutChange: (layout: Layout) => void;
  disabled: boolean;
  allCollapsed: boolean;
  onToggleAll: () => void;
}

export function DiffControls({ layout, onLayoutChange, disabled, allCollapsed, onToggleAll }: DiffControlsProps) {
  return (
    <div role="group" aria-label="Diff controls" className="flex shrink-0 items-center gap-3">
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onToggleAll}>
        {allCollapsed ? "Expand all" : "Collapse all"}
      </Button>
      <Tabs
        size="sm"
        tabs={[
          { value: "unified", label: "Unified" },
          { value: "split", label: "Split" },
        ]}
        value={layout}
        onValueChange={(value) => {
          if (value === "unified" || value === "split") onLayoutChange(value);
        }}
      />
    </div>
  );
}
