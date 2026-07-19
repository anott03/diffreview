import { Button, InputArea } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";

interface CommentEditorProps {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}

export function CommentEditor({ onSubmit, onCancel }: CommentEditorProps) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSubmit(trimmed);
    } catch {
      // Parent already surfaced the error (toast); keep the editor open so
      // the comment isn't lost.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-l-2 border-kumo-brand bg-kumo-elevated px-4 py-3">
      <InputArea
        ref={areaRef}
        value={body}
        onValueChange={setBody}
        placeholder="Leave a review comment… (⌘/Ctrl+Enter to submit)"
        autoResize
        minRows={2}
        maxRows={12}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="primary" onClick={() => void submit()} loading={saving}>
          Comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
