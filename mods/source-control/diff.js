// Turns unified-diff lines into rows to draw: inline (one column) or side by side (two).

const clean = (text) => text.replace(/\t/g, "    ") || " ";

// [{ kind: "@", text } | { kind: "-" | "+" | " ", old, new, text }], each line numbered once.
export function inlineRows(lines) {
  let old = 0, next = 0;
  const rows = [];
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (hunk) { old = +hunk[1]; next = +hunk[2]; rows.push({ kind: "@", text: hunk[3] }); continue; }
    const kind = line[0], text = clean(line.slice(1));
    if (kind === "-") rows.push({ kind, old: old++, text });
    else if (kind === "+") rows.push({ kind, new: next++, text });
    else if (kind === " ") rows.push({ kind, old: old++, new: next++, text });
    // "\ No newline at end of file" and the like are left out.
  }
  return rows;
}

// [{ kind: "@", text } | { left, right }]: removed lines face the lines that replaced them;
// a side with nothing opposite is null (drawn as filler).
export function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === "@") { out.push(row); i++; continue; }
    if (row.kind === " ") { out.push({ left: { kind: " ", n: row.old, text: row.text }, right: { kind: " ", n: row.new, text: row.text } }); i++; continue; }
    const removed = [], added = [];
    while (rows[i]?.kind === "-") removed.push(rows[i++]);
    while (rows[i]?.kind === "+") added.push(rows[i++]);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) out.push({
      left: removed[k] ? { kind: "-", n: removed[k].old, text: removed[k].text } : null,
      right: added[k] ? { kind: "+", n: added[k].new, text: added[k].text } : null,
    });
  }
  return out;
}

export const longest = (rows) => rows.reduce((n, r) => Math.max(n, r.text?.length ?? 0), 0);
