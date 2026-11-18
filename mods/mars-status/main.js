import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, focused, panes, settings, openOverlay } from "herdr";

// The Source Control mod's branch picker, opened above the branch name (its size: source-control/branches.js).
const PICKER_W = 420, PICKER_H = 422;

// The repository a click on the branch is about: the focused pane's folder, else the space's.
function repoFolder(space) {
  const f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || space?.folder;
}

export default class MarsStatus extends View {
  // The branch, like VS Code's status bar item: a click opens the branch picker.
  branch(space, t) {
    return h_flex().id("branch").h(20).px(6).ml(-6).gap(6).items_center().rounded(4).cursor_pointer()
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Checkout branch or tag, or create a branch")
      .on_mouse_down("left", (e) => {
        const zoom = Number(settings()?.zoom) || 1, b = e.bounds;
        const x = b ? b.x / zoom : e.position.x / zoom, y = b ? b.y / zoom : e.position.y / zoom;
        openOverlay({ mod: "source-control", kind: "popup", frame: "none", width: PICKER_W, height: PICKER_H,
          at: { x: Math.max(8, x), y: Math.max(8, y - PICKER_H - 6) },
          props: { picker: true, root: repoFolder(space), on: space?.machine ?? null } });
      })
      .child(svg("mods/workspace-chrome/branch.svg").size(13))
      .child(space.branch);
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(this.branch(space, t)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
