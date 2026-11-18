// Which grammar colors a file or a fenced code block, and VS Code's colors for it.

// File extensions → grammar names this Herdr's editor knows. It has no TypeScript or TOML
// grammar, so those borrow JavaScript's and YAML's (most tokens still color).
const BY_EXTENSION = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "javascript", mts: "javascript", cts: "javascript", tsx: "javascript",
  json: "json", jsonc: "json", json5: "json", yml: "yaml", yaml: "yaml", toml: "yaml",
  md: "markdown", markdown: "markdown", html: "html", htm: "html", vue: "html", svelte: "html",
  css: "css", scss: "css", less: "css", py: "python", rs: "rust", go: "go", rb: "ruby",
  sh: "bash", bash: "bash", zsh: "bash", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  java: "java", sql: "sql", zig: "zig", cs: "c_sharp", kt: "kotlin", swift: "swift", diff: "diff", patch: "diff",
};
const GRAMMARS = new Set(Object.values(BY_EXTENSION));
// Names people write after ``` that are neither an extension above nor a grammar name.
const FENCE_ALIASES = {
  typescript: "javascript", golang: "go", "c++": "cpp", xml: "html", make: "make", makefile: "make", dockerfile: "bash",
  shell: "bash", console: "bash", shellscript: "bash", powershell: "bash", ps1: "bash", pwsh: "bash",
};

export function languageOf(name) {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "bash";
  if (lower === "makefile") return "make";
  // .env files read as shell: comments, NAME=value, quoted strings, export.
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return "bash";
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return BY_EXTENSION[ext] ?? (ext || "text");
}

// The grammar for a fence's info string ("js", "python title=x"), or "text" when there is none.
export function fenceLanguage(info) {
  const word = (info || "").trim().split(/\s+/)[0].toLowerCase();
  return BY_EXTENSION[word] ?? FENCE_ALIASES[word] ?? (GRAMMARS.has(word) ? word : "text");
}

// VS Code's Dark+ and Light+ token colors.
const DARK_PLUS = {
  keyword: "#C586C0", boolean: "#569CD6", constant: "#4FC1FF", string: "#CE9178", "string.escape": "#D7BA7D",
  "string.regex": "#D16969", comment: "#6A9955", "comment.doc": "#6A9955", function: "#DCDCAA", type: "#4EC9B0",
  constructor: "#4EC9B0", number: "#B5CEA8", variable: "#9CDCFE", "variable.special": "#569CD6", property: "#9CDCFE",
  attribute: "#9CDCFE", tag: "#569CD6", operator: "#D4D4D4", punctuation: "#D4D4D4", "punctuation.bracket": "#FFD700",
  title: "#569CD6", "text.literal": "#CE9178", link_uri: "#3794FF", link_text: "#CE9178", embedded: "#D4D4D4", enum: "#4EC9B0", variant: "#4FC1FF",
};
const LIGHT_PLUS = {
  keyword: "#AF00DB", boolean: "#0000FF", constant: "#0070C1", string: "#A31515", "string.escape": "#EE0000",
  "string.regex": "#811F3F", comment: "#008000", "comment.doc": "#008000", function: "#795E26", type: "#267F99",
  constructor: "#267F99", number: "#098658", variable: "#001080", "variable.special": "#0000FF", property: "#001080",
  attribute: "#E50000", tag: "#800000", operator: "#000000", punctuation: "#000000", "punctuation.bracket": "#0431FA",
  title: "#0000FF", "text.literal": "#A31515", link_uri: "#0070C1", link_text: "#A31515", embedded: "#000000", enum: "#267F99", variant: "#0070C1",
};
// This build's markdown grammar marks only punctuation (#, **, -, ```, links) and a fence's language.
const MARKDOWN_DARK = { ...DARK_PLUS, punctuation: "#569CD6", constant: "#CE9178" };
const MARKDOWN_LIGHT = { ...LIGHT_PLUS, punctuation: "#0451A5", constant: "#A31515" };

export function syntaxFor(language, dark) {
  if (language === "markdown") return dark ? MARKDOWN_DARK : MARKDOWN_LIGHT;
  return dark ? DARK_PLUS : LIGHT_PLUS;
}
