import type { CommentSide, DiffFile } from "../shared/types";

const extensions = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  json: "json", jsonc: "jsonc", json5: "json5",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  vue: "vue", svelte: "svelte", astro: "astro",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  py: "python", pyi: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp", php: "php", sql: "sql", graphql: "graphql", gql: "graphql",
  xml: "xml", svg: "xml", ini: "ini", conf: "ini", env: "dotenv",
  tf: "hcl", tfvars: "hcl", hcl: "hcl", lua: "lua", dockerfile: "dockerfile",
} as const;

export type SyntaxLanguage = typeof extensions[keyof typeof extensions] | "make";

const languages = new Map<string, SyntaxLanguage>(Object.entries(extensions));
const filenames = new Map<string, SyntaxLanguage>([
  ["dockerfile", "dockerfile"], ["containerfile", "dockerfile"],
  ["makefile", "make"], ["gnumakefile", "make"],
  [".bashrc", "shellscript"], [".bash_profile", "shellscript"], [".zshrc", "shellscript"],
  [".profile", "shellscript"], ["gemfile", "ruby"], ["rakefile", "ruby"],
  [".gitconfig", "ini"], [".editorconfig", "ini"],
]);

export function syntaxLanguage(path: string): SyntaxLanguage | undefined {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return "dockerfile";
  return filenames.get(name) ?? (name.includes(".") ? languages.get(name.split(".").pop()!) : undefined);
}

export interface SyntaxToken {
  content: string;
  light: string;
  dark: string;
}

export interface SyntaxSource {
  path: string;
  content: string;
  side: CommentSide;
  startLine: number;
}

export interface SyntaxRequest {
  id: number;
  sources: SyntaxSource[];
}

export interface SyntaxResponse {
  id: number;
  tokens: (SyntaxToken[][] | null)[];
}

export type SyntaxLines = Map<string, SyntaxToken[]>;

export interface DiffSyntaxContent {
  content: string;
  baseContent: string;
}

export function diffSyntaxSources(file: DiffFile, complete: DiffSyntaxContent | null): SyntaxSource[] {
  if (file.isBinary) return [];
  const sources: SyntaxSource[] = [];
  for (const side of ["old", "new"] as const) {
    const path = side === "old" ? file.oldPath : file.newPath;
    if (!path || !syntaxLanguage(path)) continue;
    if (complete) {
      sources.push({ path, side, startLine: 1, content: side === "old" ? complete.baseContent : complete.content });
      continue;
    }
    let previousLine = -1;
    let block: SyntaxSource | undefined;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const number = side === "old" ? line.oldLine : line.newLine;
        if (number === undefined) continue;
        if (block && number === previousLine + 1) {
          block.content += `\n${line.content}`;
        } else {
          block = { path, side, startLine: number, content: line.content };
          sources.push(block);
        }
        previousLine = number;
      }
    }
  }
  return sources;
}
