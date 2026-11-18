// A VS Code style Source Control pane: commit box and changed files on the left, the selected
// file's diff on the right (side by side or inline).
// Props: { root: a folder inside the repository, on: machine (null for this computer),
//          picker: true to show only the branch picker (the status bar opens it as a popup) }.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { props, run, watchFolder, pickFolder, theme, settings, home, closeOverlay, window } from "herdr";
import { findRoot, readStatus, readDiff, stage, unstage, discard, commit, push, pull } from "./git.js";
import { inlineRows, splitRows, longest } from "./diff.js";
import { BranchPicker } from "./branches.js";

const ICONS = "mods/source-control";
const PANEL_MIN = 220, PANEL_MAX = 640, VIEWER_MIN = 260;
const RAIL_W = 30;                       // the rail that holds the toggle while the panel is hidden
const ROW_H = 20, CHAR_W = 7.3;   // diff rows, at the 12px code font
const SECTIONS = [
  { id: "merge", title: "MERGE CHANGES" },
  { id: "staged", title: "STAGED CHANGES" },
  { id: "changes", title: "CHANGES" },
];

const baseName = (p) => p.split("/").pop();
const dirName = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

// VS Code's git decoration colors.
function statusColor(status) {
  const dark = settings().dark !== false;
  if (status === "M") return dark ? "#E2C08D" : "#895503";
  if (status === "A" || status === "U") return dark ? "#73C991" : "#007100";
  if (status === "D") return dark ? "#C74E39" : "#AD0707";
  return dark ? "#E4676B" : "#AD0707";
}
const STATUS_NAME = { M: "Modified", A: "Added", D: "Deleted", U: "Untracked", "!": "Conflict" };

export default class SourceControl extends View {
  init(_props, cx) {
    const saved = this.load();
    this.origin = props()?.root || home();
    this.on = props()?.on ?? null;
    this.pickerOnly = Boolean(props()?.picker);
    this.panelWidth = saved.panelWidth || 320;
    this.panelOpen = saved.panelOpen !== false;
    this.diffOpen = saved.diffOpen !== false;   // false: the file list takes the whole width
    this.view = saved.view === "inline" ? "inline" : "split";
    this.sections = { merge: true, staged: true, changes: true, ...saved.sections };
    this.root = null;          // the repository's top folder, once found
    this.status = null;        // see readStatus
    this.selected = null;      // { section, path }
    this.diff = null;          // { key, rows, width, message, conflict }
    this.busy = null;          // what's running ("Staging…")
    this.error = null; this.notice = null;
    this.confirm = null;       // { files, text } waiting for "Discard"
    this.hover = null; this.dragging = false;
    this.loading = false; this.again = false; this.watched = null;
    this.message = "";
    this.input = TextareaState.new({ placeholder: "Message (Ctrl+Enter to commit)" });
    this.input.set_auto_grow(1, 6);
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.branches = new BranchPicker(this);
    this.refresh(cx);
    // The folder watcher refreshes a local repository; this catches remote ones and a failed watch.
    cx.timer.every(10000, cx => { if (!this.pickerOnly && (this.on || !this.watched)) this.refresh(cx); });
  }

  load() {
    try { return JSON.parse(localStorage.getItem("source-control") ?? "{}"); } catch { return {}; }
  }

  save() {
    localStorage.setItem("source-control", JSON.stringify({ panelWidth: this.panelWidth, panelOpen: this.panelOpen, diffOpen: this.diffOpen, view: this.view, sections: this.sections }));
  }

  // ---- Reading ----

  files(section) { return this.status?.[section] ?? []; }

  find(section, path) { return this.files(section).find(f => f.path === path) ?? null; }

  // Status, then the shown diff. A change seen while this runs queues one more pass.
  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    cx.spawn(async cx => {
      try {
        const root = this.root ?? await findRoot(this.origin, this.on);
        if (!root) { this.error = null; this.status = null; this.root = null; return; }
        const status = await readStatus(root, this.on);
        this.root = root; this.status = status;
        if (this.pickerOnly) {
          if (!this.branches.open) this.branches.setOpen(true, cx);
          return;
        }
        this.keepSelection();
        await this.loadDiff();
        this.watch(cx);
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; this.checked = true;   // checked: the first look has finished
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // After a refresh: the selected file may have moved (staged, unstaged) or gone.
  keepSelection() {
    const s = this.selected;
    if (s && this.find(s.section, s.path)) return;
    const moved = s && SECTIONS.map(x => x.id).find(id => this.find(id, s.path));
    if (moved) { this.selected = { section: moved, path: s.path }; return; }
    const first = SECTIONS.map(x => x.id).find(id => this.files(id).length);
    this.selected = first ? { section: first, path: this.files(first)[0].path } : null;
  }

  async loadDiff() {
    const s = this.selected, file = s && this.find(s.section, s.path);
    if (!file) { this.diff = null; return; }
    const key = `${s.section}:${s.path}`;
    try {
      const d = await readDiff(this.root, this.on, s.section, file);
      if (this.selected?.section !== s.section || this.selected?.path !== s.path) return;
      if (d.message) { this.diff = { key, message: d.message }; return; }
      const rows = inlineRows(d.lines);
      this.diff = { key, inline: rows, split: splitRows(rows), width: longest(rows) * CHAR_W, conflict: d.conflict };
    } catch (e) { this.diff = { key, message: `Cannot show this diff: ${e.message ?? e}` }; }
  }

  watch(cx) {
    if (this.on || this.watched === this.root) return;
    const root = this.root;
    this.watched = root;
    cx.spawn(async cx => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.refresh(cx); } }
      catch { if (this.watched === root) this.watched = null; }
    });
  }

  select(section, path, cx) {
    this.selected = { section, path };
    // Picking a file is asking to see it: a hidden diff comes back.
    if (!this.diffOpen) { this.diffOpen = true; this.save(); }
    this.diff = null;
    cx.spawn(async cx => { await this.loadDiff(); cx.notify(); });
    cx.notify();
  }

  // ---- Changing ----

  // Runs one git action, shows what's running, then refreshes.
  act(label, fn, cx) {
    if (this.busy || !this.root) return;
    this.busy = label; this.error = null; this.notice = null; this.confirm = null;
    cx.spawn(async cx => {
      try { await fn(this.root, this.on); }
      catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.busy = null;
        // The status bar's picker is done once its checkout worked.
        if (this.pickerOnly && !this.error) return closeOverlay(props().overlay);
        this.refresh(cx); cx.notify();
      }
    });
    cx.notify();
  }

  stageFiles(files, cx) { this.act("Staging…", (root, on) => stage(root, on, files.map(f => f.path)), cx); }

  unstageFiles(files, cx) { this.act("Unstaging…", (root, on) => unstage(root, on, files.map(f => f.path), this.status?.hasHead), cx); }

  // Discarding can't be undone, so it asks first (a strip above the lists).
  askDiscard(files, cx) {
    const fresh = files.filter(f => f.status === "U").length;
    const what = files.length === 1 ? baseName(files[0].path) : `${files.length} files`;
    this.confirm = { files, text: fresh === files.length
      ? `Delete ${files.length === 1 ? "untracked file " + what : fresh + " untracked files"}? This can't be undone.`
      : `Discard changes in ${what}?${fresh ? ` ${fresh} untracked file${fresh > 1 ? "s" : ""} will be deleted.` : ""} This can't be undone.` };
    cx.notify();
  }

  commitNow(cx) {
    const message = this.message.trim(), staged = this.files("staged").length, changes = this.files("changes").length;
    if (!message || this.busy || (!staged && !changes)) return;
    this.act("Committing…", async (root, on) => {
      const sha = await commit(root, on, message, !staged);
      this.input.set_value(""); this.message = "";
      this.notice = `Committed ${sha}`;
    }, cx);
  }

  pushNow(cx) {
    const st = this.status;
    this.act("Pushing…", async (root, on) => {
      await push(root, on, st);
      this.notice = st.upstream ? `Pushed to ${st.upstream}` : `Published ${st.branch}`;
    }, cx);
  }

  pullNow(cx) {
    this.act("Pulling…", async (root, on) => { await pull(root, on); this.notice = "Pulled"; }, cx);
  }

  // VS Code's Sync Changes: pull what the remote has, then push your commits.
  syncNow(cx) {
    const st = this.status;
    this.act("Syncing…", async (root, on) => {
      if (st.behind > 0) await pull(root, on);
      await push(root, on, st);
      this.notice = `Synced with ${st.upstream}`;
    }, cx);
  }

  // A branch that can be pushed: it has commits, is checked out, and the repository has a remote.
  canPush() {
    const st = this.status;
    return Boolean(st?.remotes.length && st.hasHead && st.branch && st.branch !== "detached HEAD");
  }

  openFile(path, cx) {
    run("tab.new", { name: baseName(path), mod: "mars-explorer", props: { root: this.root, on: this.on, open: [path] } });
  }

  changeFolder(cx) {
    if (this.on) return;
    cx.spawn(async cx => {
      const folder = await pickFolder({ prompt: "Open a git repository" });
      if (!folder) return;
      this.origin = folder; this.root = null; this.status = null; this.selected = null; this.diff = null; this.watched = null;
      this.refresh(cx); cx.notify();
    });
  }

  // ---- Left panel ----

  width() {
    const room = this.size ? this.size.width - VIEWER_MIN : PANEL_MAX;
    return Math.max(Math.min(PANEL_MIN, room), Math.min(this.panelWidth, room));
  }

  // The sidebar's toggle (Ctrl+B / Cmd+B, as VS Code's): in the sidebar's top row while it shows,
  // else alone in a slim rail, so a hidden sidebar costs only that.
  sideToggle(t) {
    const open = this.panelOpen;
    return div().id(open ? "sidebar-hide" : "sidebar-show").size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`${open ? "Hide" : "Show"} sidebar (${window()?.platform === "macos" ? "Cmd" : "Ctrl"}+B)`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleSide(cx); })
      .child(svg(`${ICONS}/panel-left-${open ? "close" : "open"}.svg`).size(15));
  }

  rail(t) {
    return v_flex().w(RAIL_W).flex_none().h_full().items_center().pt(6).bg(t.surface).border_r(1).border_color(t.border)
      .child(this.sideToggle(t));
  }

  toggleSide(cx) {
    this.panelOpen = !this.panelOpen;
    if (!this.panelOpen) this.diffOpen = true;   // never both hidden
    this.save(); cx.notify();
  }

  // The diff's toggle, beside the sidebar's: hidden, the file list and commit box take the whole width
  // (handy in a narrow split); picking a file shows the diff again.
  diffToggle(t) {
    const open = this.diffOpen;
    return div().id(open ? "diff-hide" : "diff-show").size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(open ? "Hide diff" : "Show diff")
      .on_click((_e, cx) => { cx.stop_propagation(); this.diffOpen = !open; this.save(); cx.notify(); })
      .child(svg(`${ICONS}/panel-right-${open ? "close" : "open"}.svg`).size(15));
  }

  icon(id, name, tip, onClick, t) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(`${ICONS}/${name}.svg`).size(14));
  }

  button(id, label, onClick, t, kind = "plain", enabled = true) {
    return div().id(id).h(24).px(10).flex_none().flex().items_center().justify_center().rounded(5).text_size(12)
      .when(enabled && kind === "primary", el => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover(s => s.bg(t.accent).text_color(t.accent_foreground)))
      .when(enabled && kind === "danger", el => el.bg(t.ansi1).text_color("#ffffff").cursor_pointer())
      .when(enabled && kind === "plain", el => el.border(1).border_color(t.border).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover)))
      .when(!enabled, el => el.border(1).border_color(t.border).text_color(t.dim))
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .child(label);
  }

  strip(t, color, text, buttons = []) {
    return h_flex().flex_none().mx(8).mb(6).px(8).py(6).gap(6).items_center().rounded(6).bg(t.raised)
      .child(div().w(3).h(16).rounded(2).bg(color).flex_none())
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(text))
      .children(buttons);
  }

  header(t) {
    const st = this.status;
    return h_flex().h(34).flex_none().pl(10).pr(6).gap(6).items_center().text_size(12).text_color(t.muted)
      .child(st ? div().flex_1().min_w(0).child(this.branches.element(this.branchButton(st, t), t))
        : h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(svg(`${ICONS}/branch.svg`).size(14).flex_none())
          .child(div().truncate().text_color(t.foreground).child(!this.checked ? "Loading…" : this.root ? "…" : "No repository")))
      .when(Boolean(this.busy) || this.loading, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(this.busy ?? "")))
      // Pull and Push are always here too, like the ones in VS Code's "…" menu.
      .when(Boolean(st?.upstream) && this.canPush(), el => el.child(
        this.icon("pull", "pull", `Pull from ${st.upstream}${st.behind ? ` (${st.behind} new)` : ""}`, cx => this.pullNow(cx), t)))
      .when(this.canPush(), el => el.child(
        this.icon("push", "push", st.upstream ? `Push to ${st.upstream}${st.ahead ? ` (${st.ahead} commit${st.ahead > 1 ? "s" : ""})` : ""}` : `Publish ${st.branch}`, cx => this.pushNow(cx), t)))
      .child(this.icon("refresh", "refresh", "Refresh", cx => this.refresh(cx), t))
      .child(this.sideToggle(t))
      .child(this.diffToggle(t));
  }

  // The branch name; a press opens the branch picker (see branches.js).
  branchButton(st, t) {
    return h_flex().id("branch").h(24).px(4).ml(-4).gap(6).items_center().rounded(4).cursor_pointer()
      .max_w(Math.max(80, (this.diffOpen || !this.size ? this.width() : this.size.width) - 170)).text_color(t.foreground).hover(s => s.bg(t.hover))
      .tooltip("Checkout branch or tag, or create a branch")
      .child(svg(`${ICONS}/branch.svg`).size(14).flex_none())
      .child(div().min_w(0).truncate().child(st.branch ?? "…"))
      .child(svg(`${ICONS}/chevron-down.svg`).size(12).flex_none().text_color(t.muted));
  }

  commitBox(t) {
    return v_flex().flex_none().px(8).pb(8).gap(6)
      .child(div().id("message").min_h(30).px(8).py(5).rounded(5).border(1).border_color(t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.input).w_full().text_size(12.5).text_color(t.foreground)))
      .child(this.actionButton(t).w_full().h(28));
  }

  // VS Code's one big button: Commit while there are changes; once everything is committed,
  // Publish Branch (never pushed) or Sync Changes (commits to push or pull).
  actionButton(t) {
    const st = this.status, staged = this.files("staged").length, changes = this.files("changes").length;
    const label = (icon, text, counts = "") => h_flex().gap(6).items_center()
      .child(svg(`${ICONS}/${icon}.svg`).size(14)).child(div().child(text))
      .when(Boolean(counts), el => el.child(div().text_size(11.5).child(counts)));
    if (this.busy && this.busy !== "Staging…" && this.busy !== "Unstaging…" && this.busy !== "Discarding…")
      return this.button("action", label(this.busy === "Committing…" ? "check" : this.busy === "Pulling…" ? "pull" : this.busy === "Syncing…" ? "sync" : "push", this.busy), () => {}, t, "primary", false);
    if (staged || changes || !this.canPush())
      return this.button("action", label("check", staged || !changes ? "Commit" : "Commit All"), cx => this.commitNow(cx), t, "primary",
        Boolean(this.message.trim()) && !this.busy && (staged > 0 || changes > 0));
    if (!st.upstream)
      return this.button("action", label("publish", "Publish Branch"), cx => this.pushNow(cx), t, "primary", !this.busy)
        .tooltip(`Push ${st.branch} to ${st.remotes.includes("origin") ? "origin" : st.remotes[0]} and track it`);
    if (st.ahead || st.behind)
      return this.button("action", label("sync", "Sync Changes", `${st.behind ? `${st.behind}↓ ` : ""}${st.ahead ? `${st.ahead}↑` : ""}`.trim()),
        cx => this.syncNow(cx), t, "primary", !this.busy)
        .tooltip(`${st.behind ? `Pull ${st.behind} commit${st.behind > 1 ? "s" : ""} from ${st.upstream}, then ` : ""}push ${st.ahead} commit${st.ahead === 1 ? "" : "s"} to ${st.upstream}`);
    return this.button("action", label("check", "Commit"), () => {}, t, "primary", false);
  }

  sectionHeader(section, files, t) {
    const open = this.sections[section.id];
    const actions = section.id === "staged" ? [this.icon("unstage-all", "minus", "Unstage All Changes", cx => this.unstageFiles(files, cx), t)]
      : section.id === "merge" ? [this.icon("stage-merge", "plus", "Stage All Merge Changes (mark resolved)", cx => this.stageFiles(files, cx), t)]
      : [this.icon("discard-all", "discard", "Discard All Changes", cx => this.askDiscard(files, cx), t),
         this.icon("stage-all", "plus", "Stage All Changes", cx => this.stageFiles(files, cx), t)];
    return h_flex().id(`section-${section.id}`).h(24).flex_none().pl(4).pr(8).gap(4).items_center().cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.sections = { ...this.sections, [section.id]: !open }; this.save(); cx.notify(); })
      .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.foreground).child(section.title))
      .children(actions)
      .child(div().flex_none().ml(2).px(6).rounded(9).bg(t.raised).text_size(11).text_color(t.foreground).child(String(files.length)));
  }

  fileRow(section, f, t) {
    const id = `${section}:${f.path}`, selected = this.selected?.section === section && this.selected?.path === f.path;
    const color = statusColor(f.status), dir = dirName(f.path);
    const actions = [
      ...(f.status !== "D" ? [this.icon(`open-${id}`, "open-file", "Open File", cx => this.openFile(f.path, cx), t)] : []),
      ...(section === "changes" ? [this.icon(`discard-${id}`, "discard", "Discard Changes", cx => this.askDiscard([f], cx), t),
                                   this.icon(`stage-${id}`, "plus", "Stage Changes", cx => this.stageFiles([f], cx), t)]
        : section === "staged" ? [this.icon(`unstage-${id}`, "minus", "Unstage Changes", cx => this.unstageFiles([f], cx), t)]
        : [this.icon(`resolve-${id}`, "plus", "Stage (mark resolved)", cx => this.stageFiles([f], cx), t)]),
    ];
    return h_flex().id(`row-${id}`).h(22).flex_none().pl(20).pr(8).gap(5).items_center().cursor_pointer()
      .bg(selected ? t.selected : t.surface).hover(s => s.bg(selected ? t.selected : t.hover))
      .on_hover((on, cx) => { const next = on ? id : this.hover === id ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
      .on_click((_e, cx) => this.select(section, f.path, cx))
      .child(svg(`${ICONS}/file.svg`).size(13).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(200).truncate().text_color(color).when(f.status === "D", el => el.line_through()).child(baseName(f.path)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
      .when(this.hover === id || selected, el => el.children(actions))
      .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(color).tooltip(STATUS_NAME[f.status]).child(f.status === "!" ? "!" : f.status));
  }

  lists(t) {
    const out = [];
    for (const section of SECTIONS) {
      const files = this.files(section.id);
      // Like VS Code, merge and staged sections show only when they have files.
      if (section.id !== "changes" && !files.length) continue;
      out.push(this.sectionHeader(section, files, t));
      if (this.sections[section.id]) for (const f of files) out.push(this.fileRow(section.id, f, t));
    }
    return v_flex().id("lists").flex_1().min_h(0).overflow_y_scrollbar().pb(6).children(out)
      .when(this.status && !this.files("changes").length && !this.files("staged").length && !this.files("merge").length,
        el => el.child(div().px(20).py(4).text_size(12).text_color(t.dim).child("No changes")))
      .when(Boolean(this.status?.limited), el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 2,000 changed files")));
  }

  panel(t) {
    const body = !this.checked
      ? div().p(14).text_size(12.5).text_color(t.dim).child("Loading…")
      : !this.root
      ? v_flex().p(14).gap(10).text_size(12.5).text_color(t.muted)
          .child(div().child(this.error ?? "This folder isn't in a git repository."))
          .when(!this.on, el => el.child(this.button("pick-repo", "Open Repository…", cx => this.changeFolder(cx), t).w(160)))
      : v_flex().flex_1().min_h(0)
          .child(this.commitBox(t))
          .when(Boolean(this.confirm), el => el.child(this.strip(t, t.ansi1, this.confirm.text, [
            this.button("confirm-discard", "Discard", cx => { const files = this.confirm.files; this.act("Discarding…", (root, on) => discard(root, on, files), cx); }, t, "danger"),
            this.button("confirm-cancel", "Cancel", cx => { this.confirm = null; cx.notify(); }, t),
          ])))
          .when(Boolean(this.error), el => el.child(this.strip(t, t.ansi1, this.error, [this.button("error-close", "Dismiss", cx => { this.error = null; cx.notify(); }, t)])))
          .when(Boolean(this.notice), el => el.child(this.strip(t, t.ansi2, this.notice, [this.button("notice-close", "OK", cx => { this.notice = null; cx.notify(); }, t)])))
          .child(this.lists(t));
    return v_flex().when(this.diffOpen, el => el.w(this.width()).flex_none()).when(!this.diffOpen, el => el.flex_1().min_w(0))
      .h_full().min_h(0).bg(t.surface)
      .child(this.header(t))
      .child(body);
  }

  splitter(t) {
    return div().id("splitter").w(5).flex_none().h_full().cursor_col_resize().bg(this.dragging ? t.accent : t.border)
      .hover(s => s.bg(t.accent))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.dragging = true; cx.notify(); });
  }

  // ---- Diff ----

  toolbar(t, section, file) {
    const where = file.status === "U" ? "Untracked" : section === "staged" ? "Index" : section === "merge" ? "Merge Conflict" : "Working Tree";
    const toggle = (mode, label) => div().id(`view-${mode}`).h(22).px(9).flex().items_center().rounded(4).text_size(11.5)
      .when(this.view === mode, el => el.bg(t.selected).text_color(t.foreground))
      .when(this.view !== mode, el => el.text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => { this.view = mode; this.save(); cx.notify(); })
      .child(label);
    return h_flex().h(36).flex_none().pl(12).pr(8).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(12.5)
      .child(svg(`${ICONS}/file.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(260).truncate().text_color(statusColor(file.status)).child(baseName(file.path)))
      .child(div().flex_none().text_color(t.muted).child(`(${where})`))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dirName(file.path)))
      .when(!this.diff?.conflict && file.status !== "U" && file.status !== "D" && file.status !== "A", el => el.child(
        h_flex().flex_none().p(1).gap(1).rounded(5).border(1).border_color(t.border).child(toggle("split", "Side by side")).child(toggle("inline", "Inline"))))
      .when(file.status !== "D", el => el.child(this.button("tb-open", "Open File", cx => this.openFile(file.path, cx), t)))
      .when(section === "changes", el => el
        .child(this.button("tb-discard", "Discard", cx => this.askDiscard([file], cx), t))
        .child(this.button("tb-stage", "Stage", cx => this.stageFiles([file], cx), t, "primary")))
      .when(section === "staged", el => el.child(this.button("tb-unstage", "Unstage", cx => this.unstageFiles([file], cx), t)))
      .when(section === "merge", el => el.child(this.button("tb-resolve", "Mark Resolved", cx => this.stageFiles([file], cx), t, "primary")));
  }

  colors(t) {
    // VS Code's diff editor line backgrounds.
    return { add: "#9bb95533", del: "#ff000033", addSign: t.ansi2, delSign: t.ansi1, filler: t.surface };
  }

  hunkRow(text, t) {
    return h_flex().w_full().h(ROW_H).flex_none().px(12).items_center().bg(t.raised).text_color(t.dim).whitespace_nowrap().child(`⋯ ${text}`);
  }

  // Only added/removed files, untracked and conflicted ones skip the two columns (one side would be empty).
  oneColumn(file) {
    return this.view === "inline" || this.diff?.conflict || ["U", "A", "D"].includes(file.status);
  }

  inlineRow(row, c, t) {
    if (row.kind === "@") return this.hunkRow(row.text, t);
    const conflictMark = this.diff.conflict && /^(<<<<<<<|=======|>>>>>>>)/.test(row.text);
    return h_flex().w_full().h(ROW_H).flex_none().items_center()
      .when(row.kind === "+", el => el.bg(c.add)).when(row.kind === "-", el => el.bg(c.del)).when(conflictMark, el => el.bg(c.del))
      .child(div().w(46).flex_none().pr(6).text_right().text_color(t.dim).child(row.old === undefined || this.diff.conflict ? "" : String(row.old)))
      .child(div().w(46).flex_none().pr(6).text_right().text_color(t.dim).child(row.new === undefined ? "" : String(row.new)))
      .child(div().w(16).flex_none().text_color(row.kind === "+" ? c.addSign : c.delSign).child(row.kind === " " ? "" : row.kind))
      .child(div().flex_none().whitespace_nowrap().pr(12).child(row.text));
  }

  // One side of a side-by-side row. Each side keeps half the width; a line too long for it is cut with "…".
  half(cell, c, t, right) {
    return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden()
      .when(right, el => el.border_l(1).border_color(t.border))
      .bg(!cell ? c.filler : cell.kind === "+" ? c.add : cell.kind === "-" ? c.del : t.background)
      .when(Boolean(cell), el => el
        .child(div().w(46).flex_none().pr(6).text_right().text_color(t.dim).child(String(cell.n)))
        .child(div().w(14).flex_none().text_color(cell.kind === "+" ? c.addSign : c.delSign).child(cell.kind === " " ? "" : cell.kind))
        .child(div().flex_1().min_w(0).truncate().pr(8).child(cell.text)));
  }

  splitRow(row, c, t) {
    if (row.kind === "@") return this.hunkRow(row.text, t);
    return h_flex().w_full().h(ROW_H).flex_none().child(this.half(row.left, c, t, false)).child(this.half(row.right, c, t, true));
  }

  viewer(t) {
    const s = this.selected, file = s && this.find(s.section, s.path);
    if (!file) return v_flex().flex_1().min_w(0).h_full().items_center().justify_center().gap(6).bg(t.background).text_color(t.dim)
      .child(svg(`${ICONS}/branch.svg`).size(36).text_color(t.border))
      .child(div().text_size(13).child(this.root ? "Select a changed file to see its diff" : this.checked ? "No repository" : "Loading…"));
    const d = this.diff, c = this.colors(t), one = this.oneColumn(file);
    const rows = d?.inline ? (one ? d.inline : d.split) : [];
    const listId = `diff-${one ? "inline" : "split"}-${d?.key ?? "none"}`;
    // Inline scrolls sideways for long lines; side by side keeps both halves on screen.
    const minWidth = one ? 46 * 2 + 16 + (d?.width ?? 0) + 12 : 0;
    return v_flex().flex_1().min_w(0).h_full().min_h(0).bg(t.background)
      .child(this.toolbar(t, s.section, file))
      .child(!d ? div().p(14).text_size(13).text_color(t.dim).child("Loading diff…")
        : d.message ? div().p(14).text_size(13).text_color(t.dim).child(d.message)
        : div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .child(div().id("diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(minWidth).h_full()
              .child(v_virtual_list(listId, rows.length, ROW_H, i => String(i),
                range => rows.slice(range.start, range.end).map(row => one ? this.inlineRow(row, c, t) : this.splitRow(row, c, t))).size_full())))
          .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0()));
  }

  render() {
    const t = theme();
    if (this.pickerOnly) return v_flex().id("branch-popup").size_full().text_size(13).text_color(t.foreground)
      .child(this.root
        ? this.branches.panel(t, this.error).size_full()
        : div().size_full().p(14).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12.5).text_color(t.muted)
          .child(!this.checked ? "Loading…" : this.error ?? "This folder isn't in a git repository."));
    return h_flex().id("source-control").size_full().min_h(0).overflow_hidden().text_size(13).text_color(t.foreground).bg(t.background)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_key_down((e, cx) => {
        if (String(e.key).toLowerCase() === "b" && (e.modifiers.control || e.modifiers.platform) && !e.modifiers.alt && !e.modifiers.shift) {
          cx.stop_propagation(); this.toggleSide(cx); return;
        }
        if (String(e.key).toLowerCase() === "enter" && (e.modifiers.control || e.modifiers.platform)) { cx.stop_propagation(); this.commitNow(cx); }
      })
      .on_mouse_move((e, cx) => {
        if (!this.dragging) return;
        this.panelWidth = Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, e.local_position.x)));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.dragging) { this.dragging = false; this.save(); cx.notify(); } })
      .when(!this.panelOpen, el => el.child(this.rail(t)))
      .when(this.panelOpen, el => el.child(this.panel(t)).when(this.diffOpen, el => el.child(this.splitter(t))))
      .when(this.diffOpen || !this.panelOpen, el => el.child(this.viewer(t)));
  }
}
