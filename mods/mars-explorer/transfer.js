// Moving files between this computer and a space's machine, through herdr-core's own
// connection (`hc exec --on`), so no ssh setup is needed. Downloads land in ~/Downloads.
// Both ways are gzipped; uploads go as base64 on stdin in chunks (hc takes at most 8 MB
// piped in), downloads in ranges, four at a time (one stream reads about 125 KB/s). Each
// lands as <name>.part, its size is checked, then it takes a free name: "a.txt", "a (1).txt"…
// Progress: pass a `job` object; it gets `total` and `done` bytes, counted per chunk or range
// (hc hands over a call's input and output whole, so nothing finer can be seen).
import { exec, home } from "herdr";

const MB = 1024 * 1024, MAX_CHUNK = 4 * MB, CHUNKS = 25, RANGES = 32, STREAMS = 4, TIMEOUT = 600000;
// The script's own arguments start at $1; inner `sh -c '…'` scripts have their own.
const sh = (script, args, on) => exec("sh", ["-c", script, "transfer", ...args], { on, timeout: TIMEOUT });
const ok = (r, what) => { if (r.code !== 0) throw new Error(r.stderr.trim() || `${what} failed (exit ${r.code})`); return r.stdout; };
const baseOf = (path) => path.replace(/\/+$/, "").split("/").pop();
const exists = async (path, on) => (await exec("test", ["-e", path], { on })).code === 0;
async function sizeOf(path, on) {
  return Number(ok(await sh('[ -f "$1" ] || { echo "Not a file: $1" >&2; exit 1; }; wc -c < "$1"', [path], on), "size").trim());
}

async function freeName(dir, name, on) {
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 0; i < 1000; i++) {
    const path = `${dir.replace(/\/+$/, "")}/${i ? `${stem} (${i})${ext}` : name}`;
    if (!(await exists(path, on)) && !(await exists(`${path}.part`, on))) return path;
  }
  throw new Error(`No free name for ${name} in ${dir}`);
}

// A file on `on` into ~/Downloads. Resolves with where it landed.
export async function download(on, remote, job = {}) {
  const size = await sizeOf(remote, on);
  job.total = size; job.done = 0;
  const dest = await freeName(`${home()}/Downloads`, baseOf(remote), null), part = `${dest}.part`;
  const n = Math.max(1, Math.min(RANGES, Math.ceil(size / MB))), len = Math.ceil(size / n) || 1;
  const pieces = Array.from({ length: n }, (_, i) => `${part}.${i}`);
  let next = 0;
  const stream = async () => {
    for (let i; (i = next++) < n;) {
      ok(await sh(
        `hc exec --on "$1" --timeout 600 -- sh -c 'tail -c +"$2" "$1" | head -c "$3" | gzip -1' sh "$2" "$3" "$4" | gunzip > "$5"`,
        [on, remote, String(i * len + 1), String(len), pieces[i]]), "download");
      job.done += Math.max(0, Math.min(len, size - i * len));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(STREAMS, n) }, stream));
    ok(await sh('out="$1"; shift; cat "$@" > "$out" && rm -f "$@"', [part, ...pieces]), "join");
    const got = await sizeOf(part, null);
    if (got !== size) throw new Error(`Got ${got} of ${size} bytes`);
    ok(await exec("mv", ["-n", part, dest]), "rename");
    return dest;
  } catch (e) {
    next = n;
    await exec("rm", ["-f", part, ...pieces]).catch(() => {});
    throw e;
  }
}

// A local file into `dir` on `on`. Resolves with where it landed.
export async function upload(on, local, dir, job = {}) {
  const size = await sizeOf(local, null), chunk = Math.min(MAX_CHUNK, Math.max(MB, Math.ceil(size / CHUNKS)));
  job.total = size; job.done = 0;
  const dest = await freeName(dir, baseOf(local), on), part = `${dest}.part`;
  try {
    for (let at = 0; at === 0 || at < size; at += chunk) {
      ok(await sh(
        `tail -c +"$2" "$1" | head -c "$3" | gzip -1 | base64 | hc exec --on "$4" -i --timeout 600 -- sh -c 'base64 -d | gunzip >> "$1"' sh "$5"`,
        [local, String(at + 1), String(chunk), on, part]), "upload");
      job.done = Math.min(size, at + chunk);
    }
    const got = await sizeOf(part, on);
    if (got !== size) throw new Error(`Sent ${got} of ${size} bytes`);
    ok(await exec("mv", ["-n", part, dest], { on }), "rename");
    return dest;
  } catch (e) {
    await exec("rm", ["-f", part], { on }).catch(() => {});
    throw e;
  }
}
