// Splits markdown into prose and fenced code blocks, so the preview can color each block by its language.
// [{ kind: "md", text }, { kind: "code", info, code, lines }], in order.
export function splitFences(text) {
  const lines = text.split(/\r?\n/), out = [];
  let prose = [], i = 0;
  const flush = () => { if (prose.length) out.push({ kind: "md", text: prose.join("\n") }); prose = []; };
  while (i < lines.length) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    // A backtick fence's info string can't contain backticks (that's inline code).
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) { prose.push(lines[i++]); continue; }
    const close = new RegExp(`^ {0,3}${open[1][0] === "`" ? "`" : "~"}{${open[1].length},}\\s*$`), body = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) body.push(lines[j++]);
    flush();
    out.push({ kind: "code", info: open[2].trim(), code: body.join("\n"), lines: Math.max(1, body.length) });
    i = j + 1;
  }
  flush();
  return out;
}
