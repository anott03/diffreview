import type { CSSProperties } from "react";
import type { SyntaxToken } from "../syntax-highlighting";

interface SyntaxStyle extends CSSProperties {
  "--syntax-light": string;
  "--syntax-dark": string;
}

export function CodeLine({ content, tokens }: { content: string; tokens?: SyntaxToken[] }) {
  if (!tokens || tokens.map((token) => token.content).join("") !== content) return content;
  return tokens.map((token, index) => {
    const style: SyntaxStyle = { "--syntax-light": token.light, "--syntax-dark": token.dark };
    return <span key={index} className="syntax-token" style={style}>{token.content}</span>;
  });
}
