import { Plus } from "@phosphor-icons/react";

export function AddCommentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Add review comment"
      aria-label="Add review comment"
      className="relative z-10 flex h-5 w-5 items-center justify-center rounded-sm bg-kumo-brand text-white"
    >
      <Plus size={10} weight="bold" />
    </button>
  );
}
