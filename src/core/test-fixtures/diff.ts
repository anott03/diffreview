import { parseGitDiff } from "../parse-diff";

export const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
export const current = original.map((line, index) => index === 4 ? "replacement" : index === 19 ? "another replacement" : line).join("\n") + "\n";
export const file = parseGitDiff(`diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -4,3 +4,3 @@
 line 4
-line 5
+replacement
 line 6
@@ -19,3 +19,3 @@
 line 19
-line 20
+another replacement
 line 21
`)[0]!;

export const zeroContextCases = [
  { header: "@@ -2,0 +3,1 @@", changes: "+inserted", content: "one\ntwo\ninserted\nthree\n", base: "one\ntwo\nthree\n", old: [1, 2, 3], fresh: [1, 2, 3, 4] },
  { header: "@@ -3,1 +2,0 @@", changes: "-removed", content: "one\ntwo\nthree\n", base: "one\ntwo\nremoved\nthree\n", old: [1, 2, 3, 4], fresh: [1, 2, 3] },
  { header: "@@ -0,0 +1,1 @@", changes: "+inserted", content: "inserted\none\n", base: "one\n", old: [1], fresh: [1, 2] },
  { header: "@@ -1,1 +0,0 @@", changes: "-removed", content: "one\n", base: "removed\none\n", old: [1, 2], fresh: [1] },
];

export function zeroContextFile(header: string, changes: string) {
  return parseGitDiff(`diff --git a/f b/f\n--- a/f\n+++ b/f\n${header}\n${changes}\n`)[0]!;
}
