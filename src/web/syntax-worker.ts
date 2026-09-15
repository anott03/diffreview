import type { LanguageInput } from "shiki";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { syntaxLanguage, type SyntaxLanguage, type SyntaxRequest, type SyntaxResponse, type SyntaxSource, type SyntaxToken } from "./syntax-highlighting";

const languageLoaders = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  astro: () => import("shiki/langs/astro.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  make: () => import("shiki/langs/make.mjs"),
} satisfies Record<SyntaxLanguage, LanguageInput>;

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;

async function highlight(source: SyntaxSource): Promise<SyntaxToken[][] | null> {
  const language = syntaxLanguage(source.path);
  if (!language || source.content.length > 1024 * 1024 || source.content.split("\n").length > 10001) return null;
  try {
    const instance = await (highlighter ??= createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }));
    await instance.loadLanguage(languageLoaders[language]);
    return instance.codeToTokensWithThemes(source.content, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      tokenizeMaxLineLength: 10000,
      tokenizeTimeLimit: 50,
    }).map((line) => line.map((token) => ({
      content: token.content,
      light: token.variants.light?.color ?? "inherit",
      dark: token.variants.dark?.color ?? "inherit",
    })));
  } catch {
    return null;
  }
}

self.onmessage = async (event: MessageEvent<SyntaxRequest>) => {
  const { id, sources } = event.data;
  const tokens = await Promise.all(sources.map(highlight));
  self.postMessage({ id, tokens } satisfies SyntaxResponse);
};
