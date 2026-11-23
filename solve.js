// Fast static site generator, byte-identical to the makefun-site reference.
// Authored for speed: compiled templates, single-pass Markdown over a shared
// line array, memoised slugs, and allocation-light text helpers.

const RESERVED = ['posts', 'tags', 'page'];
const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- text helpers ----------
const ESC = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };
function escapeHtml(text) {
  let need = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { need = true; break; }
  }
  if (!need) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const rep = ESC[text.charCodeAt(i)];
    if (rep !== undefined) { out += text.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? text : out + text.slice(start);
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function longDate(date) {
  const m = date.indexOf('-', 5);
  return `${Number(date.slice(m + 1))} ${MONTHS[Number(date.slice(5, m)) - 1]} ${date.slice(0, 4)}`;
}

// slugify with per-run memo; ASCII fast path (NFKD is identity on ASCII).
function makeSlugifier() {
  const memo = new Map();
  function slugify(text) {
    let hit = memo.get(text);
    if (hit !== undefined) return hit;
    let ascii = true;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
    let out = '';
    let gap = false;
    if (ascii) {
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        let keep = -1;
        if (c >= 65 && c <= 90) keep = c + 32;
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
        if (keep === -1) { gap = out.length > 0; continue; }
        if (gap) out += '-';
        gap = false;
        out += String.fromCharCode(keep);
      }
    } else {
      const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      for (const ch of plain) {
        let keep = null;
        if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
        else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
        if (keep === null) { gap = out.length > 0; continue; }
        if (gap) out += '-';
        gap = false;
        out += keep;
      }
    }
    if (out.length > 64) out = out.slice(0, 64);
    while (out.endsWith('-')) out = out.slice(0, -1);
    const res = out === '' ? 'untitled' : out;
    memo.set(text, res);
    return res;
  }
  return slugify;
}
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}
function wordsOfLines(lines, from) {
  let count = 0;
  for (let li = from; li < lines.length; li++) {
    const s = lines[li];
    let inWord = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
      if (ws) inWord = false;
      else if (!inWord) { inWord = true; count++; }
    }
  }
  return count;
}

// ---------- front matter ----------
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n; i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}
function valueOf(key, raw) {
  switch (key) {
    case 'title': case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) { y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10)); }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) { const c = raw[i]; if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' }; }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length <= 64 && raw.length > 0;
      if (ok) {
        let prevDash = true; // start acts like dash: first char must be alnum
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if (c === '-') { if (prevDash) { ok = false; break; } prevDash = true; }
          else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false; // trailing dash
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}
// Returns { data, bodyStart } or { error }; lines is the shared split array.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    let blank = true;
    for (let j = 0; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) { blank = false; break; } }
    if (blank || line.charCodeAt(0) === 35) continue;
    // match ^([a-z_]+):(?: (.*))?$
    let k = 0;
    while (k < line.length) { const c = line.charCodeAt(k); if ((c >= 97 && c <= 122) || c === 95) k++; else break; }
    if (k === 0 || line[k] !== ':') return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------- templates: parse (reference grammar) then compile ----------
class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
// Compile a node tree into a function (scope, H, depth, out) pushing strings.
let uid = 0;
// Path arrays are interned per compiled template and hoisted as constants, so
// rendering never allocates a path array; output accumulates in one string.
function genNodes(nodes, code, paths, sv = 'scope') {
  const intern = (p) => {
    const key = JSON.stringify(p);
    let idx = paths.indexOf(key);
    if (idx === -1) { paths.push(key); idx = paths.length - 1; }
    return `P${idx}`;
  };
  for (const n of nodes) {
    if (n.kind === 'text') {
      if (n.text !== '') code.push(`out += ${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var') {
      code.push(`out += H.esc(H.txt(H.lk(${sv}, ${intern(n.path)})));`);
    } else if (n.kind === 'raw') {
      code.push(`out += H.txt(H.lk(${sv}, ${intern(n.path)}));`);
    } else if (n.kind === 'if') {
      // Emit one block: evaluate truthiness once, branch to then/else bodies.
      const id = ++uid;
      code.push(`{ const v${id} = H.tr(H.lk(${sv}, ${intern(n.path)})); if (v${id} !== ${n.not}) {`);
      genNodes(n.then, code, paths, sv);
      if (n.else !== null) {
        code.push('} else {');
        genNodes(n.else, code, paths, sv);
      }
      code.push('} }');
    } else if (n.kind === 'for') {
      const id = ++uid;
      const child = `sc${id}`;
      code.push(`{ const xs${id} = H.lk(${sv}, ${intern(n.path)}); if (Array.isArray(xs${id})) { const len${id} = xs${id}.length; for (let k${id} = 0; k${id} < len${id}; k${id}++) { const vars${id} = {}; vars${id}[${JSON.stringify(n.name)}] = xs${id}[k${id}]; vars${id}.loop = { index: k${id} + 1, first: k${id} === 0, last: k${id} === len${id} - 1, length: len${id} }; const ${child} = { vars: vars${id}, parent: ${sv} };`);
      genNodes(n.body, code, paths, child);
      code.push('} } }');
    } else if (n.kind === 'include') {
      code.push(`{ const f = H.tpl.get(${JSON.stringify(n.name)}); if (f !== undefined && depth < 8) out += f(${sv}, H, depth + 1); }`);
    }
  }
}
function compileTemplate(nodes) {
  uid = 0;
  const paths = [];
  const code = [];
  genNodes(nodes, code, paths);
  const header = paths.map((p, i) => `const P${i} = ${p};`).join('\n');
  return new Function('scope', 'H', 'depth', `${header}\nlet out = '';\n${code.join('\n')}\nreturn out;`);
}

// ---------- markdown ----------
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}
function inline(s, env) {
  const parts = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) { parts.push(escapeHtml(s[i + 1])); i += 2; continue; }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>'); i = j + 1; }
      else { parts.push('`'); i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) { parts.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>'); i = j + 2; }
        else { parts.push('**'); i += 2; }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) { parts.push('<em>', inline(s.slice(i + 1, j), env), '</em>'); i = j + 1; }
      else { parts.push('*'); i++; }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        parts.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1; continue;
      }
      parts.push('['); i++; continue;
    }
    // plain run until next special char
    let j = i + 1;
    while (j < n) {
      const d = s[j];
      if (d === '\\' || d === '`' || d === '*' || d === '[') break;
      j++;
    }
    parts.push(escapeHtml(s.slice(i, j)));
    i = j;
  }
  return parts.join('');
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) { const c = line[i]; if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++; else break; }
  const lang = line.slice(3, i);
  for (; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; }
  return lang;
}
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function headingOf(line) {
  let i = 0;
  while (i < line.length && line[i] === '#') i++;
  if (i === 0 || i > 6) return null;
  if (i >= line.length || (line[i] !== ' ' && line[i] !== '\t')) return null;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  let end = line.length;
  while (end > i && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  const text = line.slice(i, end);
  return text === '' ? null : { depth: i === 0 ? 0 : countHash(line), text };
}
function countHash(line) { let i = 0; while (line[i] === '#') i++; return i; }
function isHR(line) {
  let base = null;
  if (line.startsWith('---')) base = 3;
  else if (line.startsWith('***')) base = 3;
  else return false;
  for (let i = base; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}
function bulletOf(line) {
  return (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? line.slice(2) : null;
}
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line[i] === '.' && line[i + 1] === ' ') return { num: Number(line.slice(0, i)), rest: line.slice(i + 2) };
  return null;
}
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i >= 2 && i < line.length;
}
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}
function renderMarkdownLines(lines, from, env, slugify) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence !== null) {
      i++;
      const bodyParts = [];
      while (i < n && !fenceClose(lines[i])) { bodyParts.push(escapeHtml(lines[i]), '\n'); i++; }
      i++;
      const cls = fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`;
      parts.push(`<pre><code${cls}>`, bodyParts.join(''), '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      parts.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { parts.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        const t = trimLine(l);
        if (t !== '') body.push(t);
        i++;
      }
      parts.push(body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const b0 = bulletOf(line);
    const o0 = b0 === null ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrdered = o0 !== null;
      const items = [];
      while (i < n) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) { items.push([trimLine(isOrdered ? m.rest : m)]); i++; }
        else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && o0.num !== 1 ? `<ol start="${o0.num}">` : `<${tag}>`;
      let s = open + '\n';
      for (const it of items) s += `<li>${inline(it.join('\n'), env)}</li>\n`;
      s += `</${tag}>\n`;
      parts.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------- pipeline ----------
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

export function run(input) {
  const slugify = makeSlugifier();
  const report = [];
  const templates = new Map(); // name -> compiled fn
  const H = { esc: escapeHtml, txt: textOf, lk: lookup, tr: truthy, tpl: templates };
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // sources
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }
  // front matter + checks in order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.words = wordsOfLines(s.lines, fm.bodyStart);
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken.get(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // markdown
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdownLines(s.lines, s.bodyStart, env, slugify);
    s.html = md.html; s.toc = md.toc; s.excerpt = md.excerpt;
  }
  // collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  posts.forEach((p, k) => { p.newer = k === 0 ? null : posts[k - 1]; p.older = k === posts.length - 1 ? null : posts[k + 1]; });
  // tags (slug computed once per name)
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push({ name, slug }); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tagsArr = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));
  // cards / pages
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  function cardOf(s) {
    return {
      title: s.data.title, url: s.url,
      date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  function pageOf(s) {
    return { ...cardOf(s), slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })), newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
  }
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagsArr.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, H, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagsArr) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCU);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagsArr.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
