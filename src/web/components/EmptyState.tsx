import { Empty } from "@cloudflare/kumo";
import { GitDiff } from "@phosphor-icons/react";

export function EmptyState() {
  return (
    <div className="grid h-full place-items-center">
      <Empty
        size="lg"
        icon={<GitDiff size={40} />}
        title="Working tree clean"
        description="No uncommitted changes to review. Comments will reappear here as soon as files change."
      />
    </div>
  );
}
