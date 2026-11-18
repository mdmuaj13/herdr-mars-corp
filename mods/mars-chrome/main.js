import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

// The sidebar's stack of views: "lists" (spaces and agents) or "inbox" (T3's inbox, t3-inbox).
const VIEWS = "sidebar-lists";
const inboxShown = () => find(layout(), VIEWS)?.active === "inbox";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      // One row of icons: Settings (a dot once an update is downloaded), Search, Add machine, and the inbox/lists switch.
      // On the narrow rail only Settings fits.
      const inbox = inboxShown();
      const icon = (id, name, label, action) => div().id(id).size(30).flex_none().relative().flex().items_center().justify_center().rounded(8)
        .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .tooltip(label).on_click(action).child(svg(`mods/mars-chrome/${name}.svg`).size(16));
      return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).gap(4).items_center()
        .when(collapsed, el => el.px(0).justify_center())
        .child(icon("settings", "settings", "Settings", () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent).absolute().top(5).right(5))))
        .when(!collapsed, el => el
          .child(icon("search", "search", "Search", () => run("mod.open", { name: "picker" })))
          .child(icon("machine", "server-rack", "Add machine", () => run("mod.open", { name: "machine-add" })))
          .child(icon("sidebar-view", inbox ? "layout-list" : "inbox", inbox ? "Show lists" : "Show inbox",
            () => run("layout.select", { stack: VIEWS, child: inbox ? "lists" : "inbox" }))));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/mars-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
