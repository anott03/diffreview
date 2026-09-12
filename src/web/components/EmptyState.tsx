import { Empty } from "@cloudflare/kumo";
import { GitDiff } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export function EmptyState({ children }: { children?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4">
        <Empty
          size="lg"
          icon={<GitDiff size={40} />}
          title="Working tree clean"
          description="No uncommitted changes to review. Saved reviews are available in Comments."
        />
        {children}
      </div>
    </div>
  );
}
