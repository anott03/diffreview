import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { ColorMode } from "./use-color-mode";
import { DIFF_THEMES } from "./pierre-diff";

export const DIFF_UNSAFE_CSS = `
  :host {
    --diffs-font-family: var(--font-mono, ui-monospace, monospace);
    --diffs-header-font-family: var(--font-sans, system-ui, sans-serif);
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    --diffs-light-bg: var(--color-kumo-base);
    --diffs-dark-bg: var(--color-kumo-base);
  }
  [data-annotation-content] {
    width: 100%;
  }
`;

export const highlighterOptions = {
  theme: DIFF_THEMES,
} satisfies WorkerInitializationRenderOptions;

export function codeOptions(colorMode: ColorMode, commentable: boolean) {
  return {
    theme: DIFF_THEMES,
    themeType: colorMode,
    overflow: "wrap",
    disableFileHeader: true,
    enableGutterUtility: commentable,
    unsafeCSS: DIFF_UNSAFE_CSS,
  } as const;
}

export function diffOptions(layout: "unified" | "split", colorMode: ColorMode, commentable: boolean) {
  return {
    ...codeOptions(colorMode, commentable),
    diffStyle: layout,
    diffIndicators: "classic",
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
  } as const;
}
