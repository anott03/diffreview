import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders comment text as Markdown (GFM). Raw HTML is never rendered —
 * react-markdown escapes it by default, so pasted markup stays inert.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`ds-md text-sm ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
