// The branch picker, as VS Code's: click the branch name, type to search, then check out a
// branch or tag, or create a new branch (from the current commit or from another ref).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, Input, InputState } from "gpui-base";
import { listRefs, checkout, createBranch } from "./git.js";

const ICONS = "mods/source-control";
export const ROW_H = 26, SHOWN = 12, WIDTH = 420;
// Tall enough for the title, the search field, SHOWN rows and the hint.
export const HEIGHT = SHOWN * ROW_H + 110;
const KIND_ICON = { branch: "branch", remote: "cloud", tag: "tag" };
const KIND_NAME = { branch: "Branch", remote: "Remote branch", tag: "Tag" };

// Branch names can't hold spaces; VS Code turns them into dashes as you type.
const cleanName = (text) => text.trim().replace(/\s+/g, "-");

export class BranchPicker {
  // view: the Source Control view (root, on, status, act).
  constructor(view) {
    this.view = view;
    this.open = false;
    this.mode = "pick";       // pick: check out; from: choose the new branch's base; name: type its name
    this.base = null;         // the ref a new branch starts from (null: the current commit)
    this.refs = null; this.error = null;
    this.query = ""; this.at = 0;
    this.search = InputState.new({ placeholder: "Search branches and tags" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.at = 0; this.top = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.choose(this.items()[this.at], cx));
    this.top = 0;             // the first row shown (the list shows SHOWN rows at a time)
  }

  setOpen(open, cx) {
    this.open = open;
    if (open) {
      this.mode = "pick"; this.base = null; this.error = null; this.refs = null;
      this.reset();
      this.search.focus();
      const { root, on } = this.view;
      cx.spawn(async cx => {
        try { this.refs = await listRefs(root, on); }
        catch (e) { this.error = String(e.message ?? e); this.refs = []; }
        cx.notify();
      });
    }
    cx.notify();
  }

  reset() { this.search.set_value(""); this.query = ""; this.at = 0; this.top = 0; }

  // What the list shows for the mode and the search text.
  items() {
    const q = this.query.trim().toLowerCase(), name = cleanName(this.query);
    if (this.mode === "name") return [{ action: "create", label: name ? `Create branch "${name}"` : "Type a name for the new branch", enabled: Boolean(name) }];
    const refs = (this.refs ?? []).filter(r => !q || r.name.toLowerCase().includes(q));
    if (this.mode === "from") return refs;
    return [
      { action: name ? "create-now" : "create", label: name ? `Create new branch "${name}"` : "Create new branch…", enabled: true },
      { action: "create-from", label: "Create new branch from…", enabled: true },
      ...refs,
    ];
  }

  choose(item, cx) {
    if (!item || item.enabled === false) return;
    const view = this.view, name = cleanName(this.query);
    // Creating: at once from a typed name, or by asking for one (and maybe a base) first.
    if (item.action === "create-now" || this.mode === "name") {
      const base = this.mode === "name" ? this.base : null;
      this.open = false;
      view.act("Creating branch…", (root, on) => createBranch(root, on, name, base), cx);
      return;
    }
    if (item.action === "create") { this.mode = "name"; this.reset(); cx.notify(); return; }
    if (item.action === "create-from") { this.mode = "from"; this.reset(); cx.notify(); return; }
    if (this.mode === "from") { this.base = item.name; this.mode = "name"; this.reset(); cx.notify(); return; }
    // A ref: check it out.
    this.open = false;
    if (item.kind === "branch" && item.name === view.status?.branch) { cx.notify(); return; }
    const locals = (this.refs ?? []).filter(r => r.kind === "branch").map(r => r.name);
    view.act("Checking out…", (root, on) => checkout(root, on, item, locals), cx);
  }

  move(e, cx) {
    const n = this.items().length;
    if (!n || (e.key !== "down" && e.key !== "up")) return;
    this.at = e.key === "down" ? (this.at + 1) % n : (this.at <= 0 ? n : this.at) - 1;
    this.top = Math.min(this.at, Math.max(this.top, this.at - SHOWN + 1));
    cx.stop_propagation();
    cx.notify();
  }

  title() {
    if (this.mode === "from") return "Select a ref to create the branch from";
    if (this.mode === "name") return `New branch from ${this.base ?? this.view.status?.branch ?? "the current commit"}`;
    return "Check out a branch or tag";
  }

  row(item, i, t) {
    const current = item.kind === "branch" && item.name === this.view.status?.branch;
    const lit = i === this.at, enabled = item.enabled !== false;
    return h_flex().id(`ref-${i}-${item.name ?? item.action}`).h(ROW_H).px(8).gap(8).flex_none().items_center().rounded(4)
      .text_color(enabled ? t.foreground : t.dim)
      .when(lit && enabled, el => el.bg(t.selected))
      .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
      .on_click((_e, cx) => this.choose(item, cx))
      .child(svg(`${ICONS}/${item.action ? "plus" : KIND_ICON[item.kind]}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_shrink_0().max_w(220).truncate().when(current, el => el.text_color(t.accent)).child(item.label ?? item.name))
      .when(!item.action, el => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
        .child(`${current ? "current · " : ""}${KIND_NAME[item.kind]} · ${item.sha} · ${item.when}`)))
      .tooltip(item.subject ? `${item.name}\n${item.sha} ${item.subject}` : item.label ?? item.name);
  }

  // SHOWN rows from this.top; the wheel moves the window, ↑↓ keep the lit row inside it.
  list(items, t) {
    const max = Math.max(0, items.length - SHOWN);
    this.top = Math.max(0, Math.min(this.top, max));
    const rows = items.slice(this.top, this.top + SHOWN).map((item, k) => this.row(item, this.top + k, t));
    return h_flex().id("branch-list").flex_none().h(Math.min(items.length, SHOWN) * ROW_H).gap(2)
      .on_scroll_wheel((e, cx) => {
        cx.stop_propagation();
        this.wheel = (this.wheel ?? 0) - e.delta.y;
        const steps = Math.trunc(this.wheel / ROW_H);
        if (!steps) return;
        this.wheel -= steps * ROW_H;
        const next = Math.max(0, Math.min(this.top + steps, max));
        if (next !== this.top) { this.top = next; cx.notify(); }
      })
      .child(v_flex().flex_1().min_w(0).children(rows))
      // A thin bar shows where the window is in a long list.
      .when(items.length > SHOWN, el => el.child(div().w(3).h_full().flex_none().relative().rounded(2).bg(t.hover)
        .child(div().absolute().left(0).right(0).rounded(2).bg(t.muted)
          .top(this.top / items.length * SHOWN * ROW_H).h(Math.max(12, SHOWN / items.length * SHOWN * ROW_H)))));
  }

  // The picker itself: a title, the search field and the list. error: one to show besides its own.
  panel(t, error = null) {
    const items = this.items(), shown = this.error ?? error;
    return v_flex().id("branch-picker-panel").p(4).gap(4).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(12.5)
      .on_key_down((e, cx) => this.move(e, cx))
      .child(div().px(8).pt(4).text_size(11).text_color(t.dim).child(this.title()))
      .child(h_flex().mx(4).h(30).px(8).gap(6).flex_none().items_center().rounded(5).border_1().border_color(t.accent).bg(t.background)
        .child(svg(`${ICONS}/${this.mode === "name" ? "branch" : "search"}.svg`).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.search).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .when(Boolean(shown), el => el.child(div().px(8).text_size(11.5).text_color(t.ansi1).child(shown)))
      .when(this.refs === null && this.mode !== "name", el => el.child(div().px(8).py(4).text_color(t.dim).child("Loading branches…")))
      .when(this.refs !== null || this.mode === "name", el => el.child(items.length
        ? this.list(items, t)
        : div().px(8).py(4).text_color(t.dim).child("No matching branches or tags")))
      .child(div().px(8).pb(2).text_size(10.5).text_color(t.dim).child("↑↓ to move · Enter to choose · Esc to close"));
  }

  // In the panel's header: trigger (the branch name) opens the picker below it.
  element(trigger, t) {
    return Popover.new("branch-picker").anchor("top_left").open(this.open)
      .on_open_change((open, cx) => this.setOpen(open, cx))
      .trigger(trigger)
      .content(this.panel(t).w(WIDTH).mt(4));
  }
}
