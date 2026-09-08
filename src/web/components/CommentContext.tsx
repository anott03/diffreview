import type { Comment } from "../../shared/types";

export function CommentContext({ comment }: { comment: Comment }) {
  const context = comment.context;
  const lines = context?.lines ?? [{ line: comment.line, content: comment.lineText }];
  const anchor = context?.line ?? comment.line;
  const label = context?.source === "snapshot"
    ? `Saved code · ${comment.side} side`
    : context?.source === "head"
      ? "Current committed code (HEAD)"
      : `Original commented line · ${comment.side} side`;

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-kumo-line">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-sm" aria-label={label}>
          <tbody>
            {lines.map((line) => (
              <tr key={line.line} className={line.line === anchor ? "bg-kumo-tint" : ""}>
                <td className="w-12 px-3 py-0.5 text-right text-kumo-subtle select-none">{line.line}</td>
                <td className="px-3 py-0.5 whitespace-pre">
                  {line.line === anchor ? <mark className="bg-transparent font-medium text-kumo-default">{line.content || " "}</mark> : line.content || " "}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!context && (
        <p className="px-3 py-1.5 text-sm text-kumo-subtle">Surrounding code is unavailable for this comment.</p>
      )}
    </div>
  );
}
