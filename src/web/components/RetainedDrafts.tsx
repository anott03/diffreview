import { Button } from "@cloudflare/kumo/components/button";
import { useState } from "react";
import { commentDraftKey, type CommentDraft, type RetainedCommentDraft } from "../comment-draft";
import { CommentEditor } from "./CommentEditor";

interface RetainedDraftsProps {
  drafts: Map<string, RetainedCommentDraft>;
  reviewId: string | null;
  onChange: (entry: RetainedCommentDraft, draft: CommentDraft | null) => void;
  onCarry: (entry: RetainedCommentDraft) => void;
  onSubmit: (entry: RetainedCommentDraft, body: string) => Promise<void>;
}

export function RetainedDrafts({ drafts, reviewId, onChange, onCarry, onSubmit }: RetainedDraftsProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  if (drafts.size === 0) return null;
  const historicalCount = [...drafts.values()].filter((entry) => entry.reviewId !== reviewId).length;

  return (
    <details className="max-h-[50%] shrink-0 overflow-y-auto border-b border-kumo-line bg-kumo-elevated text-sm">
      <summary className="cursor-pointer px-4 py-2">
        Retained drafts ({drafts.size}){historicalCount > 0 ? `, ${historicalCount} from previous reviews` : ""}
      </summary>
      <div className="space-y-3 px-4 pb-3">
        <p className="text-kumo-subtle">
          Drafts stay in this project tab, even if their files disappear. Carry a previous-review draft before saving. The server will validate its saved anchor.
        </p>
        <ul className="space-y-3">
          {[...drafts.entries()].map(([key, entry]) => {
            const current = entry.reviewId === reviewId;
            const collision = !current && drafts.has(commentDraftKey(reviewId, entry.file));
            const editing = current && editingKey === key;
            return (
              <li key={key} className="space-y-2 rounded-md border border-kumo-line px-3 py-2">
                <div className="space-y-1">
                  <h3 className="break-all font-medium">{entry.file}</h3>
                  <p className="text-kumo-subtle">
                    {current ? "Current review" : `Previous review ${entry.reviewId.slice(0, 8)}`} · {entry.draft.side}-side line {entry.draft.line}
                  </p>
                  <pre className="whitespace-pre-wrap break-all bg-kumo-recessed px-3 py-2">{entry.draft.lineText || "\u200b"}</pre>
                </div>
                {editing ? (
                  <CommentEditor
                    body={entry.draft.body}
                    onBodyChange={(body) => onChange(entry, { ...entry.draft, body })}
                    onSubmit={(body) => onSubmit(entry, body)}
                    onCancel={() => setEditingKey(null)}
                    cancelLabel="Keep draft"
                  />
                ) : (
                  <p className="whitespace-pre-wrap break-words">{entry.draft.body || "Empty draft"}</p>
                )}
                {collision && <p className="text-kumo-subtle">A current-review draft already exists for this file. Save or discard it before carrying this draft.</p>}
                <div className="flex flex-wrap gap-2">
                  {current ? (
                    !editing && <Button variant="secondary" size="sm" onClick={() => setEditingKey(key)}>Edit draft</Button>
                  ) : (
                    <Button variant="secondary" size="sm" disabled={!reviewId || collision} onClick={() => onCarry(entry)}>
                      Carry draft into current review
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => { onChange(entry, null); if (editingKey === key) setEditingKey(null); }}>Discard draft</Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
