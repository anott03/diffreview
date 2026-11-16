import { Empty } from "@cloudflare/kumo";
import { GitDiff } from "@phosphor-icons/react";

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4">
        <Empty
          size="lg"
          icon={<GitDiff size={40} />}
          title={title}
          description={description}
        />
      </div>
    </div>
  );
}
