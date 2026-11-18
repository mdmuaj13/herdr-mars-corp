// Folder listing, git marks and ignored entries for the explorer tree.
import { exec, window } from "herdr";
import * as fs from "fs/promises";

export const LIST_LIMIT = 500;

// Lists one folder: [{ name, dir }], at most LIST_LIMIT + 1 entries.
// Here it reads the folder in the app itself (no process); a folder the app can't read (outside the
// home folder) falls back to PowerShell on Windows, else sh, as on another machine.
export async function listFolder(path, on) {
  if (!on) {
    try { return await listHere(path); } catch {}
  }
  return listWithShell(path, on);
}

async function listHere(path) {
  const out = [];
  for (const e of await fs.readdir(path, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    out.push({ name: e.name, dir: e.isDirectory() });
    if (out.length > LIST_LIMIT) break;
  }
  // A directory link (a junction or symlink, as pnpm's node_modules has) reads as a file: a
  // folder is one that opens. Checked only for names without a dot, where links live.
  await Promise.all(out.filter(e => !e.dir && !e.name.includes(".")).map(async e => {
    try { await fs.readdir(`${path}/${e.name}`); e.dir = true; } catch {}
  }));
  return out;
}

async function listWithShell(path, on) {
  const windows = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First " + (LIST_LIMIT + 1) + " | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windows();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt ' + LIST_LIMIT + ' ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "explorer", path], { on }); }
  catch (e) {
    // A Windows machine reached over ssh has no sh.
    if (on && String(e).includes("cannot start sh: program not found")) return windows();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// The repository's top folder (forward slashes), or null when root isn't in one.
export async function gitTop(root, on) {
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, on }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim().replace(/\\/g, "/") : null;
}

// Git status marks: { "<absolute path, lowercase, forward slashes>": "A" | "M" | "D" | "U" }.
export async function gitMarks(root, top, on, limit) {
  const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on }).catch(() => null);
  if (status?.code !== 0) return {};
  const marks = {};
  for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, limit)) {
    const xy = entry.slice(0, 2);
    marks[`${top}/${entry.slice(3)}`.toLowerCase()] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
  }
  return marks;
}

// Which of these paths (relative to root, forward slashes) git ignores: a Set of them.
// One `git check-ignore` per ~16,000 characters of paths (Windows caps a command line at 32,767).
export async function gitIgnored(root, on, paths) {
  const ignored = new Set();
  for (let i = 0; i < paths.length;) {
    const chunk = [];
    let size = 0;
    while (i < paths.length && (chunk.length === 0 || size + paths[i].length < 16000)) { size += paths[i].length + 3; chunk.push(paths[i++]); }
    const r = await exec("git", ["-c", "core.quotePath=false", "check-ignore", "--", ...chunk], { cwd: root, on }).catch(() => null);
    // 0: some are ignored; 1: none; anything else: not a repository, or git failed.
    if (r?.code !== 0) continue;
    for (const p of r.stdout.split(/\r?\n/).filter(Boolean)) ignored.add(p.replace(/\\/g, "/").replace(/\/$/, ""));
  }
  return ignored;
}
