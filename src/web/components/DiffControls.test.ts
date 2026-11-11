import { describe, expect, it, vi } from "vitest";
import { DiffControls } from "./DiffControls";

const props = () => ({
  layout: "unified" as const,
  onLayoutChange: vi.fn(),
  disabled: false,
  allCollapsed: false,
  onToggleAll: vi.fn(),
});

describe("DiffControls", () => {
  it("offers Collapse all for expanded or mixed files and forwards the action", () => {
    const input = props();
    const [button] = DiffControls(input).props.children;
    expect(button.props.children).toBe("Collapse all");
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(input.onToggleAll).toHaveBeenCalledOnce();
  });

  it("offers Expand all when every file is collapsed", () => {
    const [button] = DiffControls({ ...props(), allCollapsed: true }).props.children;
    expect(button.props.children).toBe("Expand all");
  });

  it("disables the bulk action when the view has no usable files", () => {
    const [button] = DiffControls({ ...props(), disabled: true }).props.children;
    expect(button.props.disabled).toBe(true);
  });

  it("keeps layout controls available and ignores unexpected layout values", () => {
    const input = props();
    const [, tabs] = DiffControls(input).props.children;
    expect(tabs.props.value).toBe("unified");
    tabs.props.onValueChange("split");
    tabs.props.onValueChange("unified");
    tabs.props.onValueChange("invalid");
    expect(input.onLayoutChange.mock.calls).toEqual([["split"], ["unified"]]);
  });
});
