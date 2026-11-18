// Git for the Source Control pane: status, diffs, and the stage/unstage/discard/commit actions.
import { exec, readTextFile } from "herdr";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie), so the
// folder watch doesn't see them and each refresh doesn't start the next.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const MAX_FILES = 2000, MAX_DIFF_LINES = 5000, MAX_TEXT = 400000;

const read = (root, on, args) => exec("git", [...READ, ...args], { cwd: root, on });

// Runs a git command that changes something; throws git's own message on failure.
async function write(root, on, args) {
  const r = await exec("git", args, { cwd: root, on, timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
  return r;
}

// Long path lists go in pieces, so a Windows command line never gets too long.
async function eachChunk(paths, fn) {
  for (let i = 0; i < paths.length; i += 100) await fn(paths.slice(i, i + 100));
}

export async function findRoot(cwd, on) {
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim().replace(/\\/g, "/") : null;
}

// { branch, upstream, ahead, behind, hasHead, staged, changes, merge, limited }.
// Each file is { path, status }: M modified, A added, D deleted, U untracked, ! conflict.
export async function readStatus(root, on) {
  const r = await read(root, on, ["status", "--porcelain=v1", "-z", "--branch", "--no-renames", "--untracked-files=all"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git status failed");
  const head = await read(root, on, ["rev-parse", "--verify", "-q", "HEAD"]);
  const remotes = (await read(root, on, ["remote"])).stdout.split("\n").map(s => s.trim()).filter(Boolean);
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, hasHead: head.code === 0, remotes, staged: [], changes: [], merge: [], limited: false };
  const entries = r.stdout.split("\0").filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith("## ")) {
      const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(entry);
      out.branch = m?.[1] === "HEAD (no branch)" ? "detached HEAD" : m?.[1] ?? null;
      out.upstream = m?.[2] ?? null;
      out.ahead = Number(/ahead (\d+)/.exec(m?.[3] ?? "")?.[1] ?? 0);
      out.behind = Number(/behind (\d+)/.exec(m?.[3] ?? "")?.[1] ?? 0);
      continue;
    }
    if (out.staged.length + out.changes.length + out.merge.length >= MAX_FILES) { out.limited = true; break; }
    const x = entry[0], y = entry[1], path = entry.slice(3);
    if (CONFLICTS.has(x + y)) { out.merge.push({ path, status: "!" }); continue; }
    if (x === "?") { out.changes.push({ path, status: "U" }); continue; }
    if (x !== " ") out.staged.push({ path, status: x === "A" ? "A" : x === "D" ? "D" : "M" });
    if (y !== " ") out.changes.push({ path, status: y === "D" ? "D" : "M" });
  }
  return out;
}

// The diff of one file as unified-diff lines from the first hunk on, or { message } when
// there's no text to show. section: "staged" (index vs HEAD), "changes" (worktree vs index), "merge".
export async function readDiff(root, on, section, file) {
  if (file.status === "U" || file.status === "!") {
    const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
    if (text === null) return { message: "Cannot show this file (binary, too large, or unreadable)" };
    if (text.includes("\0")) return { message: "Binary file" };
    const lines = text.slice(0, MAX_TEXT).replace(/\r?\n$/, "").split(/\r?\n/).slice(0, MAX_DIFF_LINES);
    // A conflicted file shows as it is now, markers and all; an untracked one is all new.
    return file.status === "U"
      ? { lines: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)] }
      : { lines: [`@@ -1,${lines.length} +1,${lines.length} @@ conflict`, ...lines.map(l => ` ${l}`)], conflict: true };
  }
  const r = await read(root, on, ["diff", ...(section === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "--", file.path]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git diff failed");
  const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex(l => l.startsWith("@@"));
  if (first < 0) return { message: /^Binary files/m.test(r.stdout) ? "Binary file changed" : "No text changes (only mode or line endings)" };
  return { lines: all.slice(first, first + MAX_DIFF_LINES).map(l => l.replace(/\r$/, "")) };
}

export const stage = (root, on, paths) => eachChunk(paths, p => write(root, on, ["add", "-A", "--", ...p]));

export async function unstage(root, on, paths, hasHead) {
  await eachChunk(paths, p => write(root, on, hasHead ? ["restore", "--staged", "--", ...p] : ["rm", "--cached", "-r", "-q", "--", ...p]));
}

// Puts files back as the index has them; untracked files are deleted.
export async function discard(root, on, files) {
  const tracked = files.filter(f => f.status !== "U").map(f => f.path), fresh = files.filter(f => f.status === "U").map(f => f.path);
  await eachChunk(tracked, p => write(root, on, ["restore", "--worktree", "--", ...p]));
  await eachChunk(fresh, p => write(root, on, ["clean", "-f", "-q", "--", ...p]));
}

// Push and pull talk to the remote with your own git setup (credential manager, ssh keys).
// Nothing can be typed in here, so a remote that asks for a password fails with git's message.
const REMOTE_TIMEOUT = 180000;

async function remote(root, on, args) {
  const r = await exec("git", args, { cwd: root, on, timeout: REMOTE_TIMEOUT });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
}

// Pushes the branch; one with no upstream yet is published to origin (or the first remote).
export async function push(root, on, status) {
  if (status.upstream) return remote(root, on, ["push"]);
  const target = status.remotes.includes("origin") ? "origin" : status.remotes[0];
  if (!target) throw new Error("This repository has no remote to push to.");
  await remote(root, on, ["push", "-u", target, status.branch]);
}

// Pulls the upstream with your pull settings (merge or rebase); a merge commit keeps git's message.
export const pull = (root, on) => remote(root, on, ["pull", "--no-edit"]);

// Local branches, remote branches and tags, most recent commit first:
// [{ kind: "branch" | "remote" | "tag", name, sha, when, subject }].
export async function listRefs(root, on) {
  const r = await read(root, on, ["for-each-ref", "--sort=-committerdate",
    "--format=%(refname)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)", "refs/heads", "refs/remotes", "refs/tags"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git for-each-ref failed");
  const refs = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [ref, sha, when, ...subject] = line.replace(/\r$/, "").split("\t");
    if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")) continue;
    const kind = ref.startsWith("refs/heads/") ? "branch" : ref.startsWith("refs/remotes/") ? "remote" : "tag";
    refs.push({ kind, name: ref.replace(/^refs\/(heads|remotes|tags)\//, ""), sha, when, subject: subject.join("\t") });
  }
  // Local branches first, then remote ones, then tags (as VS Code lists them); newest first in each.
  const order = { branch: 0, remote: 1, tag: 2 };
  return refs.map((r, i) => [r, i]).sort((x, y) => order[x[0].kind] - order[y[0].kind] || x[1] - y[1]).map(([r]) => r);
}

// Checks out a ref the way VS Code does: a remote branch gets a local branch that tracks it
// (or the local one of that name), a tag is checked out detached.
export function checkout(root, on, ref, localNames) {
  if (ref.kind === "branch") return write(root, on, ["checkout", "-q", ref.name]);
  if (ref.kind === "tag") return write(root, on, ["checkout", "-q", "--detach", `refs/tags/${ref.name}`]);
  const local = ref.name.slice(ref.name.indexOf("/") + 1);
  if (localNames.includes(local)) return write(root, on, ["checkout", "-q", local]);
  return write(root, on, ["checkout", "-q", "--track", ref.name]);
}

// Creates a branch from base (default: the current commit) and switches to it.
export function createBranch(root, on, name, base) {
  if (name.startsWith("-")) throw new Error(`"${name}" is not a valid branch name.`);
  return write(root, on, ["checkout", "-q", "-b", name, ...(base ? ["--no-track", base] : [])]);
}

// Commits what's staged; with all, stages every change first (VS Code's smart commit).
export async function commit(root, on, message, all) {
  if (all) await write(root, on, ["add", "-A"]);
  await write(root, on, ["commit", "-m", message]);
  const r = await read(root, on, ["rev-parse", "--short", "HEAD"]);
  return r.stdout.trim();
}
