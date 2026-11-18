// A VS Code style file explorer pane: a folder tree on the left, opened files as tabs on the right.
// Props: { root: folder to browse, on: machine (null for this computer), open?: files under root to show }.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, writeTextFile, watchFolder, pickFolder, theme, settings, home, window } from "herdr";
import { languageOf, fenceLanguage, syntaxFor } from "./languages.js";
import { splitFences } from "./markdown.js";
import { listFolder, gitTop, gitMarks, gitIgnored, LIST_LIMIT } from "./folders.js";
import FileTree, { HOSTS } from "./filetree.js";

const ICONS = "mods/mars-explorer";
// The home folder or a drive root.
function broadFolder(path) {
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return !path || norm(path) === norm(home()) || /^([a-z]:)?$/i.test(norm(path));
}
const TOTAL = 5000, MAX_TEXT = 400000;      // tree entries; characters an editor shows
const TREE_MIN = 160, TREE_MAX = 640;
const RAIL_W = 30;                         // the rail that holds the toggle while the tree is hidden
// Editor font size, and the line height a preview code block is sized by.
const FONT_SIZE = 13, LINE_H = 20;
// Larger markdown previews as one piece, without colored code blocks.
const MD_SPLIT_MAX = 150000;

const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const isMarkdown = (path) => languageOf(baseName(path)) === "markdown";
const editorState = (language, value, options = {}) => EditorState.new({ language, value, font_family: settings().font_family,
  font_size: FONT_SIZE, syntax: syntaxFor(language, settings().dark !== false), ...options });

export default class Explorer extends View {
  init(_props, cx) {
    // Saved state belongs to the folder this pane was opened on; a different one starts fresh.
    this.origin = props()?.root || home();
    const stored = this.load(), saved = stored.origin === this.origin ? stored : {};
    this.root = saved.root || this.origin;
    this.on = props()?.on ?? null;
    this.treeWidth = saved.treeWidth || 280;
    this.treeOpen = saved.treeOpen !== false;
    this.sections = { editors: true, folder: true, ...saved.sections };
    this.folders = new Set(saved.folders ?? []);   // expanded folders
    this.tabs = [];                                // see open()
    this.active = null;                            // path of the shown tab
    this.asking = null;                            // { kind: "close", path } or { kind: "close-all" }
    this.saved = null;                             // path just saved, shown as "Saved" for a moment
    this.dragging = false;
    this.generation = 0;
    // The folder tree is filetree's view (filetree.js), embedded. It asks for files through openFromTree.
    this.treeId = `explorer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.treeQueue = []; this.treeWake = null;
    HOSTS.set(this.treeId, this);
    this.ftree = cx.new(FileTree, { embed: this.treeId });
    this.serveTree(cx);
    this.reload(cx);
    for (const path of saved.tabs ?? []) this.open(path, cx, false);
    for (const path of [].concat(props()?.open ?? [])) this.open(path, cx);
    if (saved.active && this.tabOf(saved.active)) this.active = saved.active;
    // The folder watcher refreshes local trees; this catches remote ones and a failed watch.
    cx.timer.every(10000, cx => { if (this.on || !this.watched) this.refresh(cx); });
  }

  async close() {
    for (const tab of this.tabs) this.releaseTab(tab);
    HOSTS.delete(this.treeId);
    const wake = this.treeWake; this.treeWake = null; wake?.();
    this.ftree?.release();
  }

  // Opens what the tree asked for from this view's own task, so the redraws reach this view
  // (a cx from the tree would redraw only the tree).
  serveTree(cx) {
    cx.spawn(async cx => {
      while (HOSTS.get(this.treeId) === this) {
        if (!this.treeQueue.length) await new Promise(resolve => { this.treeWake = resolve; });
        if (HOSTS.get(this.treeId) !== this) return;
        for (const path of this.treeQueue.splice(0)) this.open(path, cx);
        cx.notify();
      }
    });
  }

  // From the tree, with an absolute path. False: it's outside this folder, so the tree previews it.
  openFromTree(abs) {
    const base = this.root.replace(/[\\/]+$/, "");
    if (!abs.startsWith(base + "/")) return false;
    this.treeQueue.push(abs.slice(base.length + 1));
    const wake = this.treeWake; this.treeWake = null; wake?.();
    return true;
  }

  load() {
    try { return JSON.parse(localStorage.getItem("explorer") ?? "{}"); } catch { return {}; }
  }

  save() {
    localStorage.setItem("explorer", JSON.stringify({
      origin: this.origin, root: this.root, treeWidth: this.treeWidth, treeOpen: this.treeOpen, sections: this.sections, folders: [...this.folders],
      tabs: this.tabs.map(t => t.path), active: this.active }));
  }

  full(path) { return path ? `${this.root}/${path}` : this.root; }

  tabOf(path) { return this.tabs.find(t => t.path === path); }

  // ---- Folder tree ----

  // Start over on a new root (or the first time).
  reload(cx) {
    this.generation++;
    this.entries = new Map(); this.pending = new Set(); this.marks = {}; this.folderMarks = new Map();
    this.ignoredIn = new Map();                    // folder -> names git ignores in it
    this.top = undefined;                          // the repository's top folder; null: not in one
    this.error = null; this.limited = false; this.loading = false; this.again = null; this.watched = null;
    this.refresh(cx);
  }

  async loadFolder(path, gen) {
    const entries = await listFolder(this.full(path), this.on);
    if (gen !== this.generation || (path && !this.folders.has(path))) return;
    let used = 0;
    for (const [p, e] of this.entries) if (p !== path) used += e.length;
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(LIST_LIMIT, TOTAL - used)))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
    if (entries.length > LIST_LIMIT || used + entries.length > TOTAL) this.limited = true;
  }

  // Asks git which entries of these folders it ignores. Inside an ignored folder everything is
  // ignored, so those aren't asked about.
  async loadIgnored(folders, gen) {
    if (!this.top) return;
    const asked = [];
    for (const folder of folders) {
      if (folder && this.ignored(folder)) continue;
      for (const e of this.entries.get(folder) ?? []) asked.push(folder ? `${folder}/${e.name}` : e.name);
    }
    const found = await gitIgnored(this.full(""), this.on, asked);
    if (gen !== this.generation) return;
    for (const folder of folders) this.ignoredIn.set(folder, new Set());
    for (const path of found) {
      const at = path.lastIndexOf("/"), folder = at < 0 ? "" : path.slice(0, at);
      this.ignoredIn.get(folder)?.add(path.slice(at + 1));
    }
  }

  // Whether git ignores this path (relative to root), or a folder above it.
  ignored(path) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (this.ignoredIn.get(parts.slice(0, i).join("/"))?.has(parts[i])) return true;
    }
    return false;
  }

  // Lists folders again (all shown ones, or just `folders`), then the git marks and ignored
  // entries. A change seen while this runs queues one more pass, so none is missed.
  refresh(cx, folders = null) {
    if (this.ftree) return; // the embedded filetree lists and watches the folder itself
    if (this.loading) {
      this.again = folders && this.again !== true ? new Set([...(this.again ?? []), ...folders]) : true;
      return;
    }
    const gen = this.generation, root = this.root, on = this.on;
    const all = ["", ...this.folders], list = folders ? all.filter(f => folders.has(f)) : all;
    this.loading = true; this.again = null; if (!folders) this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of list) {
          if (gen !== this.generation) return;
          try { await this.loadFolder(path, gen); }
          catch (e) { if (!path) throw e; this.folders.delete(path); }
        }
        if (this.top === undefined) this.top = await gitTop(root, on);
        if (gen !== this.generation) return;
        if (this.top) {
          const marks = await gitMarks(root, this.top, on, TOTAL);
          if (gen !== this.generation) return;
          this.setMarks(marks);
          await this.loadIgnored(list, gen);
        }
        this.error = null; this.watch(cx);
      } catch (e) { if (gen === this.generation) this.error = String(e.message ?? e); }
      finally {
        if (gen === this.generation) {
          this.loading = false;
          const again = this.again;
          if (again) this.refresh(cx, again === true ? null : again);
        }
        cx.notify();
      }
    });
  }

  // Root as a lowercase path with forward slashes and no trailing slash.
  base() {
    return this.full("").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  }

  // Each folder holding a change shows the strongest mark under it: U, then D, M, A.
  setMarks(marks) {
    this.marks = marks;
    const base = this.base() + "/", rank = { U: 4, D: 3, M: 2, A: 1 }, folders = new Map();
    for (const [path, mark] of Object.entries(marks)) {
      if (!path.startsWith(base)) continue;
      const parts = path.slice(base.length).split("/");
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/"), had = folders.get(folder);
        if (!had || rank[mark] > rank[had]) folders.set(folder, mark);
      }
    }
    this.folderMarks = folders;
  }

  // Waits for changes under root and refreshes only what they touch: a folder the tree shows
  // is listed again when something in it changes, and the git marks when a file git tracks
  // (or could) changes. node_modules, ignored folders and git's own objects wake nothing.
  watch(cx) {
    if (this.on || this.watched === this.root) return;
    // A home folder or drive root changes many times a second (AppData, node_modules): its
    // watch would list it again without pause. The 10-second timer refreshes it instead.
    if (broadFolder(this.root)) return;
    const gen = this.generation, root = this.root;
    this.watched = root;
    cx.spawn(async cx => {
      try {
        while (gen === this.generation) {
          const changed = await watchFolder(root);
          if (gen !== this.generation) break;
          const folders = this.affected(changed);
          if (folders) this.refresh(cx, folders === true ? null : folders);
        }
      }
      catch { if (gen === this.generation) this.watched = null; }
    });
  }

  // The shown folders a batch of changed paths touches (a Set), true for everything, or null.
  affected(changed) {
    const base = this.base(), shown = new Map(["", ...this.folders].map(f => [f.toLowerCase(), f]));
    const folders = new Set();
    let marks = false;
    for (const raw of changed) {
      const path = raw.replace(/\\/g, "/").replace(/\/$/, ""), lower = path.toLowerCase();
      if (lower === base || !lower.startsWith(base + "/")) return true;
      const rel = path.slice(base.length + 1), parts = rel.split("/");
      if (parts[0] === ".git") {
        // The index, HEAD and refs change the marks; objects and logs don't.
        if (/^\.git\/(index$|head$|refs\/|packed-refs$)/i.test(rel)) marks = true;
        continue;
      }
      const at = rel.lastIndexOf("/"), parent = shown.get((at < 0 ? "" : rel.slice(0, at)).toLowerCase());
      if (parent !== undefined) folders.add(parent);
      if (!parts.includes("node_modules") && !this.ignored(rel)) marks = true;
    }
    return folders.size || marks ? folders : null;
  }

  mark(path) {
    return this.marks[this.full(path).replace(/\\/g, "/").toLowerCase()];
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder); this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const gen = this.generation;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, gen); await this.loadIgnored([path], gen); }
          catch (e) { if (gen === this.generation) this.error = String(e.message ?? e); }
          finally { if (gen === this.generation) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    this.save();
    cx.notify();
  }

  collapseAll(cx) {
    for (const folder of this.folders) this.entries.delete(folder);
    this.folders = new Set();
    this.save();
    cx.notify();
  }

  changeRoot(cx) {
    if (this.on) return; // the system picker only browses this computer
    if (this.tabs.some(t => t.dirty)) { this.asking = { kind: "close-all" }; cx.notify(); return; }
    cx.spawn(async cx => {
      const folder = await pickFolder({ prompt: "Open folder" });
      if (!folder) return;
      for (const tab of this.tabs) this.releaseTab(tab);
      this.root = folder; this.tabs = []; this.active = null; this.folders = new Set();
      this.reload(cx); this.save(); cx.notify(); cx.notify(this.ftree);
    });
  }

  // ---- Files ----

  // Opens a file in a tab (or shows its tab if already open).
  open(path, cx, focus = true) {
    if (focus) this.active = path;
    if (this.tabOf(path)) { this.save(); cx.notify(); return; }
    // state: the editor. original: the file's text as last read or saved (what writeTextFile expects on disk).
    // dirty: the editor differs from it. notice/conflict: a save problem shown above the editor.
    // mode: markdown opens rendered ("preview"); "edit" is the editor, as for every other file.
    // md: the preview's pieces, { text, segs } (see buildMarkdown).
    const tab = { path, state: null, error: null, original: null, editable: false, readonlyReason: null,
      dirty: false, notice: null, conflict: false, busy: false, mode: isMarkdown(path) ? "preview" : "edit", md: null };
    this.tabs.push(tab);
    if (!this.active) this.active = path;
    this.save();
    const full = this.full(path), on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(full, { on });
        if (!this.tabs.includes(tab)) return;
        if (text === null) { tab.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { tab.error = "Binary file · no text preview"; return; }
        const truncated = text.length > MAX_TEXT;
        // Saving writes on this computer only, and never a cut-off file.
        tab.editable = !on && !truncated;
        tab.readonlyReason = on ? "Read-only · file is on another machine" : truncated ? "Read-only · file too large to edit here" : null;
        tab.original = text;
        tab.state = editorState(languageOf(baseName(path)), truncated ? text.slice(0, MAX_TEXT) + "\n… (file truncated)" : text,
          { readonly: !tab.editable });
        tab.state.on("change", (_e, cx) => {
          const dirty = tab.state.value() !== tab.original;
          if (dirty !== tab.dirty) { tab.dirty = dirty; cx.notify(); }
        });
        this.buildMarkdown(tab);
      } catch { if (this.tabs.includes(tab)) tab.error = "Cannot preview this file (binary, larger than 1 MiB, or unreadable)"; }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  // Splits a markdown tab's text into prose and code blocks, each block a read-only editor
  // colored by its fence's language. Runs only when the text changed since the last split.
  buildMarkdown(tab) {
    if (!tab?.state || !isMarkdown(tab.path)) return;
    const text = tab.state.value();
    if (tab.md?.text === text) return;
    this.releaseMarkdown(tab);
    const segs = text.length > MD_SPLIT_MAX ? [{ kind: "md", text }] : splitFences(text);
    for (const seg of segs) if (seg.kind === "code")
      seg.state = editorState(fenceLanguage(seg.info), seg.code, { readonly: true, line_numbers: false, folding: false });
    tab.md = { text, segs };
  }

  releaseMarkdown(tab) {
    for (const seg of tab.md?.segs ?? []) seg.state?.release();
    tab.md = null;
  }

  releaseTab(tab) {
    tab.state?.release();
    this.releaseMarkdown(tab);
  }

  setMode(tab, mode, cx) {
    if (mode === "preview") this.buildMarkdown(tab);
    tab.mode = mode;
    cx.notify();
  }

  // Writes the editor's text, only if the file on disk is still what was opened (or overwrite).
  saveFile(tab, cx, overwrite = false) {
    if (!tab?.state || !tab.editable || tab.busy || (!tab.dirty && !overwrite)) return;
    const full = this.full(tab.path), text = tab.state.value();
    tab.busy = true; cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(full, text, overwrite ? await readTextFile(full) : tab.original);
        tab.original = text; tab.dirty = tab.state.value() !== text;
        tab.notice = null; tab.conflict = false;
        this.saved = tab.path;
        cx.timer.after(2500, cx => { if (this.saved === tab.path) { this.saved = null; cx.notify(); } });
      } catch (e) {
        const message = String(e.message ?? e);
        tab.conflict = message.includes("changed outside");
        tab.notice = tab.conflict ? "This file changed on disk after you opened it." : `Could not save: ${message.replace(/^.*?writeTextFile`?:?\s*/, "")}`;
      } finally { tab.busy = false; cx.notify(); }
    });
  }

  // Sets the editor (and the file's known disk text) and clears edits and problems.
  resetTab(tab, text, original = text) {
    tab.original = original; tab.state.set_value(text); this.buildMarkdown(tab);
    tab.dirty = false; tab.notice = null; tab.conflict = false;
  }

  // Throws away edits: back to what's on disk now.
  reloadFile(tab, cx) {
    if (!tab?.state) return;
    cx.spawn(async cx => {
      const text = await readTextFile(this.full(tab.path), { on: this.on }).catch(() => null);
      if (text === null) tab.notice = "Could not read the file from disk.";
      else this.resetTab(tab, text);
      cx.notify();
    });
  }

  revertFile(tab, cx) {
    if (!tab?.state) return;
    this.resetTab(tab, tab.original);
    cx.notify();
  }

  saveAll(cx) {
    for (const tab of this.tabs) this.saveFile(tab, cx);
  }

  // Closing a file with unsaved edits asks first (the bar above the editor).
  closeTab(path, cx, force = false) {
    const i = this.tabs.findIndex(t => t.path === path);
    if (i < 0) return;
    if (!force && this.tabs[i].dirty) { this.active = path; this.asking = { kind: "close", path }; this.save(); cx.notify(); return; }
    if (this.asking?.path === path) this.asking = null;
    this.releaseTab(this.tabs[i]);
    this.tabs.splice(i, 1);
    if (this.active === path) this.active = (this.tabs[i] ?? this.tabs[i - 1])?.path ?? null;
    this.save();
    cx.notify();
  }

  closeAll(cx, force = false) {
    if (!force && this.tabs.some(t => t.dirty)) { this.asking = { kind: "close-all" }; cx.notify(); return; }
    this.asking = null;
    for (const tab of this.tabs) this.releaseTab(tab);
    this.tabs = []; this.active = null;
    this.save();
    cx.notify();
  }

  select(path, cx) {
    this.active = path;
    this.save();
    cx.notify();
  }

  toggleSection(name, cx) {
    this.sections = { ...this.sections, [name]: !this.sections[name] };
    this.save();
    cx.notify();
  }

  // ---- Left side: Open Editors and the folder ----

  // The tree never takes more than what leaves the file view 240px.
  width() {
    const room = this.size ? this.size.width - 245 : TREE_MAX;
    return Math.max(Math.min(TREE_MIN, room), Math.min(this.treeWidth, room));
  }

  // The sidebar's toggle (Ctrl+B / Cmd+B, as VS Code's): in the sidebar's top row while it shows,
  // else alone in a slim rail, so a hidden sidebar costs only that.
  sideToggle(t) {
    const open = this.treeOpen;
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
    this.treeOpen = !this.treeOpen;
    this.save(); cx.notify();
  }

  tree(t) {
    const { editors, folder } = this.sections;
    return v_flex().w(this.width()).flex_none().h_full().min_h(0).bg(t.surface)
      .child(this.sectionHeader("editors", this.tabs.length ? `OPEN EDITORS · ${this.tabs.length}` : "OPEN EDITORS", [
        this.action("close-all", "close-all", cx => this.closeAll(cx), t),
      ], t, [this.sideToggle(t)]))
      .when(editors, el => el.child(this.openEditors(t)))
      .child(this.sectionHeader("folder", baseName(this.root).toUpperCase(), [
        ...(this.on ? [] : [this.action("change-root", "folder-open", cx => this.changeRoot(cx), t)]),
      ], t))
      .when(folder, el => el.child(v_flex().flex_1().min_h(0).overflow_hidden().child(this.ftree)))
      .when(!folder, el => el.child(div().flex_1()));
  }

  // A collapsible section header: chevron, title, then actions (shown while open).
  // always: shown whether the section is open or not (the sidebar toggle).
  sectionHeader(name, title, actions, t, always = []) {
    const open = this.sections[name];
    return h_flex().id(`section-${name}`).h(26).flex_none().pl(4).pr(6).gap(4).items_center().cursor_pointer()
      .border_t(1).border_color(t.border).bg(t.surface).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleSection(name, cx))
      .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.foreground).child(title))
      .when(open, el => el.children(actions))
      .children(always);
  }

  // A small icon button for a section header.
  action(id, icon, onClick, t) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(`${ICONS}/${icon}.svg`).size(14));
  }

  openEditors(t) {
    return v_flex().id("open-editors").flex_none().h(Math.min(224, Math.max(1, this.tabs.length) * 22 + 4)).overflow_y_scrollbar().py(2)
      .children(this.tabs.map(tab => {
        const on = tab.path === this.active, slash = tab.path.lastIndexOf("/");
        return h_flex().id(`editor-${tab.path}`).h(22).flex_none().pl(8).pr(8).gap(6).items_center().cursor_pointer()
          .bg(on ? t.selected : t.surface).hover(s => s.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => this.select(tab.path, cx))
          .child(this.closeMark(`editor-close-${tab.path}`, tab, on, t))
          .child(svg(`${ICONS}/file.svg`).size(13).flex_none().text_color(t.muted))
          .child(div().flex_none().max_w(180).truncate().text_color(t.foreground).child(baseName(tab.path)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(slash > 0 ? tab.path.slice(0, slash) : ""));
      }))
      .when(this.tabs.length === 0, el => el.child(div().px(12).py(4).text_size(12).text_color(t.dim).child("No open files")));
  }

  folderTree(t) {
    const rows = this.rows("", 0, [], t);
    return v_flex().id("tree").flex_1().min_h(0).overflow_y_scrollbar().py(2).children(rows)
      .when(Boolean(this.error) || !rows.length, el => el.child(div().p(10).text_size(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading files…" : "Empty folder"))))
      .when(this.limited, el => el.child(div().p(10).text_size(11).text_color(t.dim)
        .child(`Limited to ${LIST_LIMIT} entries per folder, ${TOTAL} total`)));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      const selected = !entry.dir && this.active === path;
      // As VS Code: a changed file in its status color with its letter, a folder holding changes
      // in the strongest one with a dot, and what git ignores dimmed.
      const ignored = this.ignored(path), mark = ignored ? null : entry.dir ? this.folderMarks.get(path.toLowerCase()) : this.mark(path);
      const markColor = mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked;
      const nameColor = mark ? markColor : ignored ? t.dim : t.foreground;
      out.push(h_flex().id(`row-${path}`).h(24).flex_none().pl(6 + depth * 14).pr(8).gap(5).items_center().cursor_pointer()
        .bg(selected ? t.selected : t.surface).hover(s => s.bg(selected ? t.selected : t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.open(path, cx))
        .tooltip(ignored ? `${entry.name} (ignored by git)` : entry.name)
        .child(entry.dir ? svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`${ICONS}/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(ignored ? t.dim : entry.dir ? t.accent : t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(nameColor).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(entry.dir ? 9 : 11).text_color(markColor).child(entry.dir ? "●" : mark))));
      if (entry.dir && open) {
        if (this.pending.has(path) && !this.entries.has(path)) out.push(div().h(24).flex_none().pl(26 + depth * 14).text_size(12).text_color(t.dim).child("Loading…"));
        this.rows(path, depth + 1, out, t);
      }
    }
    return out;
  }

  splitter(t) {
    return div().id("splitter").w(5).flex_none().h_full().cursor_col_resize().bg(this.dragging ? t.accent : t.border)
      .hover(s => s.bg(t.accent))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.dragging = true; cx.notify(); });
  }

  // ---- Right side: tabs, toolbar, the file ----

  viewer(t) {
    const tab = this.tabOf(this.active);
    if (!tab) return v_flex().flex_1().min_w(0).h_full().items_center().justify_center().gap(6).bg(t.background).text_color(t.dim)
      .child(svg(`${ICONS}/file.svg`).size(36).text_color(t.border))
      .child(div().text_size(13).child("Pick a file on the left to read it"));
    const bar = this.bar(t, tab);
    return v_flex().flex_1().min_w(0).h_full().min_h(0).bg(t.background)
      .child(this.tabBar(t))
      .child(this.toolbar(t, tab))
      .when(Boolean(bar), el => el.child(bar))
      .child(!tab.state ? div().p(14).text_size(13).text_color(t.dim).child(tab.error || "Loading file…")
        : tab.mode === "preview" && tab.md ? this.preview(t, tab)
        : Editor.new(tab.state).flex_1().min_h(0));
  }

  tabBar(t) {
    return h_flex().id("file-tabs").h(34).flex_none().overflow_x_scrollbar().bg(t.chrome).border_b(1).border_color(t.border)
      .children(this.tabs.map(tab => {
        const on = tab.path === this.active, name = baseName(tab.path);
        return h_flex().id(`tab-${tab.path}`).h_full().flex_none().pl(12).pr(6).gap(6).items_center().cursor_pointer()
          .border_r(1).border_color(t.border).bg(on ? t.background : t.chrome)
          .text_size(12.5).text_color(on ? t.foreground : t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.select(tab.path, cx))
          .on_mouse_down("middle", (_e, cx) => this.closeTab(tab.path, cx))
          .child(svg(`${ICONS}/file.svg`).size(13).text_color(t.muted))
          .child(div().max_w(200).truncate().child(name))
          // Two open files with one name: show each one's folder.
          .when(this.tabs.some(x => x !== tab && baseName(x.path) === name), el => el.child(
            div().max_w(140).truncate().text_size(11).text_color(t.dim).child(tab.path.split("/").slice(-2, -1)[0] ?? "")))
          .child(this.closeMark(`close-${tab.path}`, tab, on, t));
      }));
  }

  // VS Code's close control: × normally, ● while the file has unsaved edits (still closes).
  closeMark(id, tab, on, t) {
    return div().id(id).size(18).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(tab.dirty ? t.foreground : on ? t.muted : t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(tab.path, cx); })
      .child(tab.dirty ? div().size(8).rounded(4).bg(t.foreground) : svg(`${ICONS}/close.svg`).size(12));
  }

  // Breadcrumbs on the left; Preview/Edit (markdown), save state and buttons on the right.
  toolbar(t, tab) {
    const status = tab.busy ? "Saving…" : tab.dirty ? "● Unsaved changes" : this.saved === tab.path ? "Saved" : "";
    return h_flex().h(32).flex_none().pl(12).pr(8).gap(4).items_center().text_size(11.5).text_color(t.dim).border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).gap(4).items_center().overflow_hidden()
        .children(tab.path.split("/").flatMap((c, i) => i ? [div().child("›"), div().flex_none().child(c)] : [div().flex_none().child(c)])))
      .when(isMarkdown(tab.path) && Boolean(tab.state), el => el.child(tab.mode === "preview"
        ? this.button("md-edit", "Edit", cx => this.setMode(tab, "edit", cx), t)
        : this.button("md-preview", "Preview", cx => this.setMode(tab, "preview", cx), t)))
      .when(Boolean(tab.readonlyReason), el => el.child(div().flex_none().child(tab.readonlyReason)))
      .when(tab.editable, el => el
        .child(div().flex_none().pr(4).text_color(tab.dirty ? t.blocked : t.dim).child(status))
        .when(tab.dirty, el => el.child(this.button("revert", "Revert", cx => this.revertFile(tab, cx), t)))
        .child(this.button("save", "Save", cx => this.saveFile(tab, cx), t, true, tab.dirty && !tab.busy)));
  }

  button(id, label, onClick, t, primary = false, enabled = true) {
    return div().id(id).h(22).px(10).flex_none().flex().items_center().rounded(5).text_size(12)
      .when(primary && enabled, el => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover(s => s.bg(t.accent).text_color(t.accent_foreground)))
      .when(!primary && enabled, el => el.border(1).border_color(t.border).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover)))
      .when(!enabled, el => el.border(1).border_color(t.border).text_color(t.dim))
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .child(label);
  }

  // A strip above the editor: a question about unsaved edits, or a save problem.
  bar(t, tab) {
    const a = this.asking;
    if (a?.kind === "close" && a.path === tab.path) {
      return this.strip(t, t.blocked, `Save changes to ${baseName(tab.path)} before closing?`, [
        this.button("ask-save", "Save", cx => { this.asking = null; this.saveFile(tab, cx); }, t, true),
        this.button("ask-discard", "Don't save", cx => this.closeTab(tab.path, cx, true), t),
        this.button("ask-cancel", "Cancel", cx => { this.asking = null; cx.notify(); }, t),
      ]);
    }
    if (a?.kind === "close-all") {
      const n = this.tabs.filter(x => x.dirty).length;
      return this.strip(t, t.blocked, `${n} file${n > 1 ? "s have" : " has"} unsaved changes.`, [
        this.button("ask-save-all", "Save all", cx => { this.asking = null; this.saveAll(cx); }, t, true),
        this.button("ask-discard-all", "Discard all", cx => this.closeAll(cx, true), t),
        this.button("ask-cancel-all", "Cancel", cx => { this.asking = null; cx.notify(); }, t),
      ]);
    }
    if (tab.notice) {
      return this.strip(t, t.ansi1, tab.notice, tab.conflict ? [
        this.button("conflict-overwrite", "Overwrite with mine", cx => this.saveFile(tab, cx, true), t, true),
        this.button("conflict-reload", "Load disk version", cx => this.reloadFile(tab, cx), t),
      ] : [this.button("notice-close", "Dismiss", cx => { tab.notice = null; cx.notify(); }, t)]);
    }
    return null;
  }

  strip(t, color, text, buttons) {
    return h_flex().min_h(36).flex_none().px(12).py(6).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
      .child(div().w(3).h(18).rounded(2).bg(color).flex_none())
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(text))
      .children(buttons);
  }

  // Rendered markdown; each fenced code block is a read-only editor sized to its lines.
  preview(t, tab) {
    return v_flex().id(`md-preview-${tab.path}`).flex_1().min_h(0).overflow_y_scroll().px(28).py(20).gap(12).text_size(14)
      .children(tab.md.segs.flatMap((seg, i) => seg.kind === "md"
        ? (seg.text.trim() ? [TextView.markdown(`md-${tab.path}-${i}`, seg.text).selectable(true)] : [])
        : [v_flex().w_full().flex_none().rounded(6).border(1).border_color(t.border).bg(t.background).overflow_hidden()
          .when(Boolean(seg.info), el => el.child(div().px(12).pt(6).text_size(11).text_color(t.dim).child(seg.info.split(/\s+/)[0])))
          .child(div().w_full().h(seg.lines * LINE_H + 8).px(8).py(4).child(Editor.new(seg.state).size_full()))]));
  }

  render() {
    const t = theme();
    return h_flex().id("explorer").size_full().min_h(0).overflow_hidden().text_size(13).text_color(t.foreground).bg(t.background)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      // Ctrl+S (Cmd+S on macOS) saves the shown file; with Shift, every file.
      .on_key_down((e, cx) => {
        if (String(e.key).toLowerCase() === "b" && (e.modifiers.control || e.modifiers.platform) && !e.modifiers.alt && !e.modifiers.shift) {
          cx.stop_propagation(); this.toggleSide(cx); return;
        }
        if (String(e.key).toLowerCase() !== "s" || !(e.modifiers.control || e.modifiers.platform) || e.modifiers.alt) return;
        cx.stop_propagation();
        if (e.modifiers.shift) this.saveAll(cx);
        else this.saveFile(this.tabOf(this.active), cx);
      })
      .on_mouse_move((e, cx) => {
        if (!this.dragging) return;
        this.treeWidth = Math.round(Math.max(TREE_MIN, Math.min(TREE_MAX, e.local_position.x)));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.dragging) { this.dragging = false; this.save(); cx.notify(); } })
      .when(!this.treeOpen, el => el.child(this.rail(t)))
      .when(this.treeOpen, el => el.child(this.tree(t)).child(this.splitter(t)))
      .child(this.viewer(t));
  }
}
