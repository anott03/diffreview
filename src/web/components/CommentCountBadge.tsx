import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import type { CommentStatus } from "../../shared/types";

export function CommentCountBadge({ count, status }: { count: number; status: CommentStatus | "all" }) {
  if (count === 0) return null;
  const label = status === "all" ? "comments" : `${status} comments`;
  return (
    <Sidebar.MenuBadge className={status === "open" ? "border-kumo-warning/50 text-kumo-warning" : undefined} title={`${count} ${label}`}>
      {count}
    </Sidebar.MenuBadge>
  );
}
