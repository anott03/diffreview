import { describe, expect, it } from "vitest";
import { activateProject, closeProject, projectFromPath, projectUrl, reconcileProjectTabs, restoreProjectTabs } from "./project-tabs";

const saved = JSON.stringify({ ids: ["a", "b", "a"], activeId: "b" });

describe("project navigation", () => {
  it("restores ordered, unique tabs with the saved active project", () => {
    expect(restoreProjectTabs("/", saved)).toEqual({ ids: ["a", "b"], activeId: "b" });
  });

  it("gives a direct URL precedence over another browser tab's saved selection", () => {
    expect(restoreProjectTabs("/projects/c", saved)).toEqual({ ids: ["a", "b", "c"], activeId: "c" });
    expect(restoreProjectTabs("/projects/a", saved)).toEqual({ ids: ["a", "b"], activeId: "a" });
  });

  it("opens direct links despite missing or corrupt browser storage", () => {
    for (const storage of [null, "{", '{"ids":[2],"activeId":"b"}']) {
      expect(restoreProjectTabs("/projects/a", storage)).toEqual({ ids: ["a"], activeId: "a" });
    }
  });

  it("encodes URL segments and rejects malformed paths", () => {
    expect(projectFromPath(projectUrl("a/b?c"))).toBe("a/b?c");
    expect(projectFromPath("/projects/%broken")).toBeNull();
    expect(projectFromPath("/projects/a/comments")).toBeNull();
    expect(projectUrl(null)).toBe("/");
  });

  it("activates existing tabs without changing their order and preserves tabs on home", () => {
    const state = restoreProjectTabs("/", saved);
    expect(activateProject(state, "a")).toEqual({ ids: ["a", "b"], activeId: "a" });
    expect(activateProject(state, null)).toEqual({ ids: ["a", "b"], activeId: null });
  });

  it("chooses an adjacent tab on close without changing another active tab", () => {
    expect(closeProject({ ids: ["a", "b", "c"], activeId: "b" }, "b")).toEqual({ ids: ["a", "c"], activeId: "c" });
    expect(closeProject({ ids: ["a", "b"], activeId: "b" }, "b")).toEqual({ ids: ["a"], activeId: "a" });
    expect(closeProject({ ids: ["a", "b"], activeId: "a" }, "b")).toEqual({ ids: ["a"], activeId: "a" });
    expect(closeProject({ ids: ["a"], activeId: "a" }, "a")).toEqual({ ids: [], activeId: null });
  });

  it("drops stale saved IDs but retains the direct target so its failure can be shown", () => {
    expect(reconcileProjectTabs({ ids: ["old", "a", "missing"], activeId: "missing" }, new Set(["a"])))
      .toEqual({ ids: ["a", "missing"], activeId: "missing" });
  });
});
