export function normalizeTextLines(text: string): string {
  return text.replaceAll("\r\n", "\n");
}
