// hum_editor.js — CodeMirror 6 multi-file editor for the hum_tune tool.
//
// Loaded as an ES module (the rest of hum_tune.html is a classic script). This
// file owns the editor *component* and a tiny workbench around it: a buffer
// registry, a tab strip, and per-extension languages (.hum + .toml). File I/O
// (pickers, save, compile) is the classic script's job — it drives this through
// the `window.humEditor` bridge; this side never touches the device or compiler.
//
// CM6 packages resolve through the import map in hum_tune.html's <head>, which
// pins single copies of @codemirror/state and @codemirror/view.

import { EditorView, basicSetup } from "codemirror";
import { keymap, hoverTooltip, Decoration } from "@codemirror/view";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { snippetCompletion } from "@codemirror/autocomplete";
import { linter, lintGutter } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import { toml } from "@codemirror/legacy-modes/mode/toml";

// ── .hum lexical tokenizer ────────────────────────────────────────────────────
// Categories mirror hum/grammar.lark. A light state machine tracks node
// declarations so the type after `node <name> :` colors as a node type even when
// it is a lowercase subgraph name (e.g. `node band1 : peak_band`).
const KEYWORDS = new Set([
  "import", "define", "graph", "node", "pin", "block_divisor",
  "input", "output", "load", "design", "init",
  "type", "channels", "block_size",
]);
const TYPEWORDS = new Set([
  "float32", "fixed32", "ufixed32", "float", "int", "bool", "string", "any",
]);

const FLOAT_RE = /^(?:[0-9]+\.[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)/;
const INT_RE   = /^[0-9]+/;
const WORD_RE  = /^[A-Za-z_][A-Za-z0-9_]*/;

const humLanguage = StreamLanguage.define({
  name: "hum",
  startState: () => ({ expect: null }),
  token(stream, state) {
    if (stream.eatSpace()) return null;

    if (stream.match(/^#.*/)) return "comment";

    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      let ch;
      while ((ch = stream.next()) != null) {
        if (ch === '"' && !escaped) break;
        escaped = !escaped && ch === "\\";
      }
      return "string";
    }

    if (stream.match(/^@[A-Za-z_][A-Za-z0-9_]*/)) { state.expect = null; return "annotation"; }
    if (stream.match(/^(->|~>)/)) { state.expect = null; return "wire"; }
    if (stream.match(FLOAT_RE) || stream.match(INT_RE)) { state.expect = null; return "number"; }

    const word = stream.match(WORD_RE);
    if (word) {
      const w = word[0];
      if (state.expect === "typeName") { state.expect = null; return "nodeType"; }
      if (w === "node")                { state.expect = "instName"; return "keyword"; }
      if (state.expect === "instName") { state.expect = "afterInst"; return "variable"; }
      if (w === "true" || w === "false") return "atom";
      if (KEYWORDS.has(w))  return "keyword";
      if (TYPEWORDS.has(w)) return "typeName";
      return "variable";
    }

    const c = stream.next();
    if (c === ":") {
      if (state.expect === "afterInst") state.expect = "typeName";
      return "punctuation";
    }
    if ("+-*/=".includes(c)) return "operator";
    if ("{}[](),.".includes(c)) return "punctuation";
    return null;
  },
  tokenTable: {
    keyword:     t.keyword,
    typeName:    t.typeName,
    nodeType:    t.className,
    atom:        t.atom,
    number:      t.number,
    string:      t.string,
    comment:     t.lineComment,
    annotation:  t.meta,
    wire:        t.operator,
    operator:    t.operator,
    punctuation: t.punctuation,
    variable:    t.variableName,
  },
});

const tomlLanguage = StreamLanguage.define(toml);

// Colors pulled from the app palette (CSS vars cascade into the editor DOM).
const humHighlight = HighlightStyle.define([
  { tag: t.lineComment,  color: "var(--muted)", fontStyle: "italic" },
  { tag: t.keyword,      color: "#818cf8", fontWeight: "600" },
  { tag: t.typeName,     color: "var(--param)" },
  { tag: t.className,    color: "var(--accent2)" },
  { tag: t.atom,         color: "#f472b6" },
  { tag: t.number,       color: "#fbbf24" },
  { tag: t.string,       color: "#86efac" },
  { tag: t.meta,         color: "#f59e0b" },
  { tag: t.operator,     color: "#cbd5e1" },
  { tag: t.punctuation,  color: "var(--muted)" },
  { tag: t.propertyName, color: "var(--accent2)" },   // TOML keys
  { tag: t.definition(t.variableName), color: "var(--accent2)" },
  { tag: t.variableName, color: "var(--text)" },
]);

const humTheme = EditorView.theme({
  "&":              { color: "var(--text)", backgroundColor: "#18181c", height: "100%" },
  ".cm-content":    { fontFamily: "'Consolas','Monaco',monospace", fontSize: "13px", caretColor: "var(--accent2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent2)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
                    { backgroundColor: "#33415580" },
  ".cm-gutters":    { backgroundColor: "#1a1a1e", color: "var(--muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "#ffffff08" },
  ".cm-activeLineGutter": { backgroundColor: "#ffffff08" },
  ".cm-hum-linked-selection": { backgroundColor: "#4f46e544", outline: "1px solid #818cf866" },
}, { dark: true });

// ── Semantic authoring assistance ─────────────────────────────────────────────
// Node contracts come from the same bundled manifests used by the compiler.
// The current buffer is tokenized structurally (rather than matched with an
// ever-growing pile of regular expressions), and the most recent InspectionModel
// enriches hover with resolved runtime information after a successful build.
let nodeIndex = [];   // [{ name, fqn, namespace, description, inputs, outputs, params }]
let nodeByName = new Map();
let inspectionModel = null;

function fmtDefault(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return "[" + v.join(", ") + "]";
  if (typeof v === "string") return '"' + v + '"';
  return String(v);
}

function snipEscape(s) { return String(s).replace(/[\\${}]/g, "\\$&"); }

function rebuildNodeLookup() {
  nodeByName = new Map();
  for (const n of nodeIndex) {
    nodeByName.set(n.fqn, n);
    if (!nodeByName.has(n.name)) nodeByName.set(n.name, n);
  }
}

function nodeSnippet(n, boost = 1) {
  let i = 1;
  const lines = (n.params || []).filter(p => !p.source).map(p => {
    const ann = p.mutable === "param" ? " @param" : p.mutable === "array" ? " @array" : "";
    return `    ${p.name}: \${${i++}:${snipEscape(fmtDefault(p.default))}}${ann}`;
  });
  const body = lines.length ? `{\n${lines.join(",\n")}\n}` : `{\n    $0\n}`;
  return snippetCompletion(`${n.name} ${body}`, {
    label: n.name,
    type: "class",
    detail: n.namespace || "",
    info: n.description || undefined,
    boost,
  });
}

// Minimal Hum tokenizer for editor context. It deliberately knows only lexical
// structure; semantic facts (pins/params/types) come from manifests/inspection.
function humTokens(text) {
  const out = [];
  let i = 0;
  const isStart = c => /[A-Za-z_]/.test(c);
  const isWord  = c => /[A-Za-z0-9_]/.test(c);
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '"') {
      const from = i++;
      let value = '';
      while (i < text.length) {
        const ch = text[i++];
        if (ch === '\\' && i < text.length) { value += text[i++]; continue; }
        if (ch === '"') break;
        value += ch;
      }
      out.push({ kind: 'string', value, from, to: i });
      continue;
    }
    if (isStart(c)) {
      const from = i++;
      while (i < text.length && isWord(text[i])) i++;
      out.push({ kind: 'word', value: text.slice(from, i), from, to: i });
      continue;
    }
    if ((c === '-' || c === '~') && text[i + 1] === '>') {
      out.push({ kind: 'symbol', value: c + '>', from: i, to: i + 2 }); i += 2; continue;
    }
    if ('{}[](),.:=@'.includes(c)) {
      out.push({ kind: 'symbol', value: c, from: i, to: i + 1 }); i++; continue;
    }
    const from = i++;
    while (i < text.length && !/\s/.test(text[i]) && !'{}[](),.:=@#"'.includes(text[i])) i++;
    out.push({ kind: 'other', value: text.slice(from, i), from, to: i });
  }
  return out;
}

function matchClose(tokens, openIndex, openValue = '{', closeValue = '}') {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i].value === openValue) depth++;
    else if (tokens[i].value === closeValue && --depth === 0) return i;
  }
  return -1;
}

function parseAssignedParams(tokens, fromIndex, toIndex) {
  const names = new Set();
  let depth = 0;
  for (let i = fromIndex; i < toIndex; i++) {
    const t = tokens[i];
    if ('{[('.includes(t.value)) { depth++; continue; }
    if ('}])'.includes(t.value)) { depth--; continue; }
    if (depth === 0 && t.kind === 'word' && tokens[i + 1]?.value === ':') names.add(t.value);
  }
  return names;
}

function parseHumModel(text) {
  const tokens = humTokens(text);
  const model = { tokens, imports: [], graphs: [] };

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === 'import' && tokens[i + 1]?.kind === 'string')
      model.imports.push(tokens[i + 1].value);
  }

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'graph' || tokens[i + 1]?.kind !== 'word') continue;
    const nameTok = tokens[i + 1];
    let j = i + 2;
    const params = [];
    if (tokens[j]?.value === '(') {
      const close = matchClose(tokens, j, '(', ')');
      const stop = close >= 0 ? close : tokens.length;
      for (let k = j + 1; k < stop; k++) {
        if (tokens[k].kind === 'word' && tokens[k + 1]?.value === ':') params.push(tokens[k].value);
      }
      j = close >= 0 ? close + 1 : stop;
    }
    while (j < tokens.length && tokens[j].value !== '{') j++;
    if (j >= tokens.length) continue;
    const close = matchClose(tokens, j);
    const bodyToIndex = close >= 0 ? close : tokens.length;
    const graph = {
      name: nameTok.value, nameFrom: nameTok.from, nameTo: nameTok.to,
      from: tokens[i].from, bodyFrom: tokens[j].to,
      bodyTo: close >= 0 ? tokens[close].from : text.length,
      to: close >= 0 ? tokens[close].to : text.length,
      params, pins: [], nodes: [], tokenFrom: j + 1, tokenTo: bodyToIndex,
    };

    let k = j + 1;
    while (k < bodyToIndex) {
      const t = tokens[k];
      if (t.value === 'pin' && tokens[k + 1]?.kind === 'word' && tokens[k + 2]?.value === ':' && tokens[k + 3]?.kind === 'word') {
        graph.pins.push({ name: tokens[k + 1].value, direction: tokens[k + 3].value,
                          from: t.from, to: tokens[k + 3].to });
      }
      if (t.value === 'node' && tokens[k + 1]?.kind === 'word' && tokens[k + 2]?.value === ':' && tokens[k + 3]?.kind === 'word') {
        const inst = tokens[k + 1], type = tokens[k + 3];
        let q = k + 4;
        let paramsFrom = null, paramsTo = null, paramOpen = -1, paramClose = -1;
        if (tokens[q]?.value === '{') {
          paramOpen = q;
          const pc = matchClose(tokens, q);
          paramClose = pc;
          paramsFrom = tokens[q].to;
          paramsTo = pc >= 0 ? tokens[pc].from : graph.bodyTo;
          q = pc >= 0 ? pc + 1 : bodyToIndex;
        }
        const assigned = paramOpen >= 0 ? parseAssignedParams(tokens, paramOpen + 1, paramClose >= 0 ? paramClose : bodyToIndex) : new Set();
        graph.nodes.push({
          name: inst.value, type: type.value, from: t.from,
          to: q < tokens.length ? tokens[q]?.from ?? type.to : type.to,
          nameFrom: inst.from, nameTo: inst.to, typeFrom: type.from, typeTo: type.to,
          paramsFrom, paramsTo, assigned,
        });
        if (q > k) { k = q; continue; }
      }
      k++;
    }
    model.graphs.push(graph);
    if (close >= 0) i = close;
  }
  return model;
}

function graphAt(model, pos) {
  return model.graphs.find(g => pos >= g.from && pos <= g.to) || null;
}
function nodeAt(graph, pos) {
  return graph?.nodes.find(n => pos >= n.from && pos <= Math.max(n.to, n.paramsTo ?? n.typeTo)) || null;
}
function tokenAt(model, pos) {
  return model.tokens.find(t => pos >= t.from && pos <= t.to) || null;
}
function wordRange(state, pos) {
  let from = pos, to = pos;
  const text = state.doc.toString();
  while (from > 0 && /[A-Za-z0-9_]/.test(text[from - 1])) from--;
  while (to < text.length && /[A-Za-z0-9_]/.test(text[to])) to++;
  return { from, to, text: text.slice(from, pos) };
}
function subgraphType(model, typeName) { return model.graphs.find(g => g.name === typeName && g.name !== 'main') || null; }
function manifestFor(typeName) { return nodeByName.get(typeName) || null; }
function typePins(typeName, model, direction) {
  const m = manifestFor(typeName);
  if (m) return (direction === 'output' ? m.outputs : m.inputs) || [];
  const sg = subgraphType(model, typeName);
  if (sg) return sg.pins.filter(p => p.direction === direction).map(p => ({ name: p.name, type: 'graph', channels: '?' }));
  return [];
}
function typeParams(typeName, model) {
  const m = manifestFor(typeName);
  if (m) return (m.params || []).filter(p => !p.source);
  const sg = subgraphType(model, typeName);
  return sg ? sg.params.map(name => ({ name, type: 'graph-param', default: null, mutable: 'const' })) : [];
}

function importedBoost(node, model) {
  if (!model.imports.length) return 1;
  return model.imports.includes(node.namespace) ? 3 : -1;
}

function completionTypePosition(model, context) {
  const tokens = model.tokens.filter(t => t.to <= context.pos || (t.from < context.pos && t.kind === 'word'));
  const r = wordRange(context.state, context.pos);
  let i = tokens.length - 1;
  if (tokens[i]?.kind === 'word' && tokens[i].from >= r.from) i--;
  if (tokens[i]?.value !== ':') return null;
  if (tokens[i - 1]?.kind !== 'word' || tokens[i - 2]?.value !== 'node') return null;
  const options = nodeIndex.map(n => nodeSnippet(n, importedBoost(n, model)));
  for (const g of model.graphs) {
    if (g.name === 'main') continue;
    let n = 1;
    const lines = g.params.map(p => `    ${p}: \${${n++}:}`);
    options.push(snippetCompletion(`${g.name} ${lines.length ? `{\n${lines.join(',\n')}\n}` : '{\n    $0\n}'}`, {
      label: g.name, type: 'class', detail: 'subgraph', boost: 4,
    }));
  }
  return options.length ? { from: r.from, options, validFor: /^[A-Za-z_]\w*$/ } : null;
}

function completionParam(model, context) {
  const g = graphAt(model, context.pos), n = nodeAt(g, context.pos);
  if (!n || n.paramsFrom == null || context.pos < n.paramsFrom || context.pos > (n.paramsTo ?? context.pos)) return null;
  const r = wordRange(context.state, context.pos);
  const options = typeParams(n.type, model).filter(p => !n.assigned.has(p.name) || (r.text && p.name.startsWith(r.text))).map(p => {
    const ann = p.mutable === 'param' ? ' @param' : p.mutable === 'array' ? ' @array' : '';
    const dflt = fmtDefault(p.default);
    const apply = `${p.name}: \${1:${snipEscape(dflt)}}${ann}`;
    return snippetCompletion(apply, {
      label: p.name, type: 'property', detail: [p.type, p.mutable !== 'const' ? p.mutable : ''].filter(Boolean).join(' · '),
      info: paramInfoText(p), boost: 5,
    });
  });
  return options.length ? { from: r.from, options, validFor: /^[A-Za-z_]\w*$/ } : null;
}

function endpointContext(model, context) {
  const g = graphAt(model, context.pos);
  if (!g) return null;
  const line = context.state.doc.lineAt(context.pos);
  const lineTokens = model.tokens.filter(t => t.from >= line.from && t.from < line.to);
  const r = wordRange(context.state, context.pos);
  const before = lineTokens.filter(t => t.to <= context.pos || (t.from < context.pos && t.kind === 'word'));
  let i = before.length - 1;
  if (before[i]?.kind === 'word' && before[i].from >= r.from) i--;
  if (before[i]?.value !== '.' || before[i - 1]?.kind !== 'word') return null;
  const instance = before[i - 1].value;
  const dotPos = before[i].from;
  const arrow = lineTokens.find(t => t.value === '->' || t.value === '~>');
  const direction = arrow && dotPos < arrow.from ? 'output' : 'input';
  const decl = g.nodes.find(n => n.name === instance);
  if (!decl) return null;
  return { graph: g, decl, instance, direction, from: r.from };
}

function completionPin(model, context) {
  const ep = endpointContext(model, context);
  if (!ep) return null;
  const pins = typePins(ep.decl.type, model, ep.direction);
  const options = pins.map(p => {
    const variadic = !!p.variadic;
    const apply = variadic ? `${p.name}[\${1:0}]` : p.name;
    return snippetCompletion(apply, {
      label: p.name, type: 'property', detail: pinDetail(p, ep.direction),
      info: variadic ? 'Variadic pin; select the slot index.' : undefined,
      boost: 6,
    });
  });
  return options.length ? { from: ep.from, options, validFor: /^[A-Za-z_]\w*$/ } : null;
}

function humComplete(context) {
  const text = context.state.doc.toString();
  const model = parseHumModel(text);

  const pin = completionPin(model, context);
  if (pin) return pin;
  const param = completionParam(model, context);
  if (param) return param;
  const type = completionTypePosition(model, context);
  if (type) return type;

  const word = context.matchBefore(/[A-Za-z_]\w*/);
  if (word && (context.explicit || word.text.length >= 2) && 'node'.startsWith(word.text)) {
    return {
      from: word.from,
      options: [snippetCompletion('node ${1:name} : ${2:Type} {\n    $0\n}',
                                  { label: 'node', type: 'keyword', detail: 'declaration' })],
      validFor: /^[A-Za-z_]\w*$/,
    };
  }
  return null;
}

function pinDetail(p, direction) {
  const bits = [direction];
  if (p.type) bits.push(p.type);
  if (p.channels !== undefined && p.channels !== null) bits.push(`${p.channels} ch`);
  if (p.variadic) bits.push('variadic');
  return bits.join(' · ');
}
function pinSummary(p) {
  const bits = [];
  if (p.type) bits.push(p.type);
  if (p.channels !== undefined && p.channels !== null) bits.push(`${p.channels} ch`);
  if (p.block_size !== undefined && p.block_size !== null) bits.push(`block ${p.block_size}`);
  if (p.variadic) bits.push(`variadic${p.min_count != null || p.max_count != null ? ` ${p.min_count ?? 0}..${p.max_count ?? '∞'}` : ''}`);
  return `${p.name}: ${bits.join(', ')}`;
}
function paramSummary(p) {
  const bits = [p.type || 'value'];
  if (p.default !== undefined && p.default !== null) bits.push(`= ${fmtDefault(p.default)}`);
  if (p.min != null || p.max != null) bits.push(`[${p.min ?? '−∞'}..${p.max ?? '∞'}]`);
  if (p.mutable && p.mutable !== 'const') bits.push(`@${p.mutable}`);
  if (p.source) bits.push(`← ${p.source}`);
  return `${p.name}: ${bits.join(' ')}`;
}
function paramInfoText(p) {
  const bits = [];
  if (p.type) bits.push(`type: ${p.type}`);
  if (p.default !== undefined && p.default !== null) bits.push(`default: ${fmtDefault(p.default)}`);
  if (p.min !== undefined && p.min !== null) bits.push(`min: ${p.min}`);
  if (p.max !== undefined && p.max !== null) bits.push(`max: ${p.max}`);
  if (p.mutable) bits.push(`mutability: ${p.mutable}`);
  if (p.source) bits.push(`compiler source: ${p.source}`);
  return bits.join('\n');
}
function spanContains(span, path, line, column) {
  if (!span) return false;
  const norm = s => String(s || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const want = norm(path), got = norm(span.file);
  if (want && got && want !== got && !want.endsWith('/' + got) && !got.endsWith('/' + want)) return false;
  const sl = Number(span.line || 1), sc = Number(span.column || 1);
  const el = Number(span.end_line || sl), ec = Number(span.end_column || sc + 1);
  if (line < sl || line > el) return false;
  if (line === sl && column < sc) return false;
  if (line === el && column > ec) return false;
  return true;
}
function inspectionNodeForBufferPos(state, pos) {
  if (!inspectionModel || !Array.isArray(inspectionModel.nodes)) return null;
  const b = buffers.find(x => x.id === activeId);
  if (!b) return null;
  const line = state.doc.lineAt(pos);
  const col = pos - line.from + 1;
  return inspectionModel.nodes.find(n => spanContains(n.source, b.path || b.name, line.number, col)) || null;
}
function tooltipDom(title, rows, description = '') {
  const root = document.createElement('div');
  root.className = 'hum-hover';
  root.style.cssText = 'max-width:420px;padding:8px 10px;font:12px/1.45 Consolas,Monaco,monospace;color:#e5e7eb;background:#222228;border:1px solid #454550;border-radius:5px;box-shadow:0 6px 18px #0008';
  const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-weight:700;color:#c4b5fd;margin-bottom:4px'; root.appendChild(h);
  if (description) { const d = document.createElement('div'); d.textContent = description; d.style.cssText = 'color:#cbd5e1;margin-bottom:5px;max-width:55ch'; root.appendChild(d); }
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === '') continue;
    const row = document.createElement('div');
    const key = document.createElement('span'); key.textContent = k + ': '; key.style.color = '#94a3b8';
    const val = document.createElement('span'); val.textContent = String(v);
    row.append(key, val); root.appendChild(row);
  }
  return root;
}

const humHover = hoverTooltip((view, pos) => {
  const state = view.state, text = state.doc.toString(), model = parseHumModel(text);
  const tok = tokenAt(model, pos);
  if (!tok || tok.kind !== 'word') return null;
  const g = graphAt(model, pos), n = nodeAt(g, pos);
  let title = null, rows = [], description = '';

  if (n && tok.from === n.typeFrom) {
    const m = manifestFor(n.type);
    const sg = subgraphType(model, n.type);
    title = n.type;
    if (m) {
      description = m.description || '';
      rows = [['fully qualified', m.fqn], ['inputs', (m.inputs || []).map(pinSummary).join(' · ')],
              ['outputs', (m.outputs || []).map(pinSummary).join(' · ')], ['parameters', (m.params || []).map(paramSummary).join(' · ')]];
    } else if (sg) rows = [['kind', 'subgraph'], ['parameters', sg.params.join(', ')], ['pins', sg.pins.map(p => p.name).join(', ')]];
  } else if (n && tok.from === n.nameFrom) {
    const m = manifestFor(n.type), runtime = inspectionNodeForBufferPos(state, pos);
    title = `${n.name} : ${n.type}`;
    description = m?.description || runtime?.description || '';
    rows = runtime ? [['instance path', runtime.instance_path], ['runtime node', runtime.runtime_node_id],
                      ['schedule', runtime.schedule_index], ['type', runtime.fqn || n.type]] : [['type', m?.fqn || n.type]];
  } else if (n && n.paramsFrom != null && pos >= n.paramsFrom && pos <= (n.paramsTo ?? pos)) {
    const p = typeParams(n.type, model).find(p => p.name === tok.value);
    if (p) { title = `${n.name}.${p.name}`; rows = [['type', p.type], ['default', fmtDefault(p.default)], ['range', p.min != null || p.max != null ? `${p.min ?? '−∞'} … ${p.max ?? '∞'}` : ''], ['mutability', p.mutable], ['source', p.source]]; }
  }

  if (!title && g) {
    const tokens = model.tokens;
    const idx = tokens.indexOf(tok);
    // Instance reference in a connection endpoint, e.g. `wet.out -> mix.in[0]`.
    // Declaration hover is handled above; references need to resolve through
    // the current graph's local instance symbol table.
    const refDecl = g.nodes.find(x => x.name === tok.value);
    if (refDecl && tokens[idx + 1]?.value === '.') {
      const m = manifestFor(refDecl.type);
      const sg = subgraphType(model, refDecl.type);
      title = `${refDecl.name} : ${refDecl.type}`;
      if (m) {
        description = m.description || '';
        rows = [['type', m.fqn || refDecl.type],
                ['inputs', (m.inputs || []).map(pinSummary).join(' · ')],
                ['outputs', (m.outputs || []).map(pinSummary).join(' · ')]];
      } else if (sg) {
        rows = [['kind', 'subgraph'],
                ['parameters', sg.params.join(', ')],
                ['pins', sg.pins.map(p => p.name).join(', ')]];
      } else {
        rows = [['type', refDecl.type]];
      }
    }
    if (!title && idx > 1 && tokens[idx - 1]?.value === '.' && tokens[idx - 2]?.kind === 'word') {
      const decl = g.nodes.find(x => x.name === tokens[idx - 2].value);
      if (decl) {
        const all = [...typePins(decl.type, model, 'input').map(p => [p, 'input']), ...typePins(decl.type, model, 'output').map(p => [p, 'output'])];
        const hit = all.find(([p]) => p.name === tok.value);
        if (hit) { const [p, dir] = hit; title = `${decl.name}.${p.name}`; rows = [['direction', dir], ['type', p.type], ['channels', p.channels], ['block size', p.block_size], ['variadic', p.variadic ? 'yes' : 'no']]; }
      }
    }
  }
  if (!title) {
    const m = manifestFor(tok.value);
    if (m) { title = m.name; description = m.description || ''; rows = [['fully qualified', m.fqn], ['namespace', m.namespace]]; }
  }
  if (!title) return null;
  return { pos: tok.from, end: tok.to, above: true, create: () => ({ dom: tooltipDom(title, rows, description) }) };
}, { hoverTime: 350 });

// ── Diagnostics (Block 3b: debounced linter) ──────────────────────────────────
// `checker` is supplied by the classic-script controller; it runs the real
// compiler in the Pyodide worker and returns raw diagnostic dicts
// ({code,message,file?,line?,column?,notes?,hints?}).  We map those onto ranges
// in the active .hum buffer.  Context (which buffer) is local; only the error
// data crosses to Pyodide.
let checker = null;

function toDiagnostic(state, d) {
  const doc = state.doc;
  const lineNo = Math.min(Math.max(d.line || 1, 1), doc.lines);
  const lineObj = doc.line(lineNo);
  let from = Math.min(lineObj.from + Math.max((d.column || 1) - 1, 0), lineObj.to);
  // Underline the token at the position, else to end of line.
  const rest = lineObj.text.slice(from - lineObj.from);
  const tok = /^[A-Za-z_][\w.]*|^\S+/.exec(rest);
  let to = tok ? Math.min(from + tok[0].length, lineObj.to) : lineObj.to;
  if (to <= from) {
    // Column at/after EOL (e.g. unexpected-EOF) would give a zero-width,
    // invisible range — back up to cover the last character on the line.
    from = Math.max(lineObj.from, from - 1);
    to = Math.min(from + 1, lineObj.to);
  }
  const extra = [].concat(d.notes || [], d.hints || []);
  const message = `[${d.code}] ${d.message}` + (extra.length ? "\n" + extra.join("\n") : "");
  return { from, to: Math.max(to, from), severity: "error", source: d.code, message };
}

async function humLint(view) {
  if (!checker) return [];
  const id = activeId;                       // the buffer we are about to lint
  const b = buffers.find(x => x.id === id);
  if (!b || b.language !== "hum") return [];
  let raw;
  try { raw = await checker(b.path, view.state.doc.toString()); }
  catch (e) { return []; }
  // If the user switched buffers during the (slow) worker round-trip, drop the
  // result — its positions only make sense against the doc we linted, and CM6
  // will re-lint the now-active buffer.
  if (activeId !== id) return [];
  return (raw || []).map(d => toDiagnostic(view.state, d));
}

// ── Workbench state ───────────────────────────────────────────────────────────
// buffers: [{ id, path, name, display, handle, language, dirty, state }]
//   path:    identity + compile/save key — relative to the PROJECT ROOT so it
//            matches compileProject's files map (null for untitled)
//   display: what the tab tooltip / breadcrumb show — includes the project
//            folder name (e.g. eq_5band/src/main.hum); falls back to path/name
//   handle:  FileSystemFileHandle when available (enables silent Save)
//   state:  this buffer's EditorState (doc + history + language). The ACTIVE
//           buffer's live edits live in view.state until it is switched away.
const buffers = [];
let activeId  = null;
let uid       = 0;
let switching = false;   // guard so setState() does not mark a buffer dirty
let muteCursorEvents = false; // graph → editor navigation isn't a user cursor selection
let linkedSourceSpans = []; // compiler-owned spans selected in other panes
const setLinkedMarks = StateEffect.define();
const linkedMarksField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setLinkedMarks)) return effect.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: field => EditorView.decorations.from(field),
});

const hostEl = document.getElementById("editor-host");
const tabsEl = document.getElementById("editor-tabs");
const pathEl = document.getElementById("editor-path");
let view = null;

function langName(name) { return (name && name.endsWith(".toml")) ? "toml" : "hum"; }

function cursorLocation() {
  const b = buffers.find(x => x.id === activeId);
  if (!b) return null;
  const head = view ? view.state.selection.main.head : b.state.selection.main.head;
  const doc = view ? view.state.doc : b.state.doc;
  const line = doc.lineAt(head);
  return {
    path: b.path || b.name,
    name: b.name,
    line: line.number,
    column: head - line.from + 1,
  };
}

function emitCursorLocation() {
  if (muteCursorEvents) return;
  const loc = cursorLocation();
  if (loc) window.dispatchEvent(new CustomEvent("humeditor-cursor", { detail: loc }));
}

const updateL = EditorView.updateListener.of(u => {
  if (!switching && u.docChanged) {
    const b = buffers.find(x => x.id === activeId);
    if (b && !b.dirty) { b.dirty = true; renderTabs(); }
  }
  if (!switching && u.selectionSet)
    queueMicrotask(emitCursorLocation);
});

// Recompute marks when a file becomes active or shared selection changes.
// Only paths matching the current buffer are shown (multi-file project safe).
function refreshLinkedMarks() {
  const b = buffers.find(x => x.id === activeId);
  if (!b || !view) return;
  const norm = x => String(x || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const path = norm(b.path || b.name);
  const doc = view.state.doc;
  const matches = linkedSourceSpans.filter(span => {
    const want = norm(span.file);
    return want === path || (!b.path && want.endsWith(".hum") && b.language === "hum");
  });
  const ranges = [];
  for (const span of matches) {
    if (!span.line || span.line > doc.lines) continue;
    const l1 = doc.line(Math.max(1, Number(span.line)));
    const l2 = doc.line(Math.min(doc.lines, Math.max(1, Number(span.end_line || span.line))));
    const from = Math.min(l1.to, l1.from + Math.max(0, Number(span.column || 1) - 1));
    const to = Math.min(l2.to, l2.from + Math.max(0, Number(span.end_column || span.column || 1) - 1));
    if (to > from) ranges.push(Decoration.mark({class: 'cm-hum-linked-selection'}).range(from, to));
  }
  ranges.sort((a,b) => a.from - b.from || a.to - b.to);
  view.dispatch({effects: setLinkedMarks.of(Decoration.set(ranges, true))});
}

// Prec.highest so these win over basicSetup's defaultKeymap, which binds Mod-s
// (browser save) implicitly and Mod-Enter to insertBlankLine — otherwise our
// Compile/Save shortcuts are shadowed and never fire.
const editorKeymap = Prec.highest(keymap.of([
  { key: "Mod-s",     preventDefault: true, run: () => { window.dispatchEvent(new Event("humeditor-save")); return true; } },
  { key: "Mod-Enter", preventDefault: true, run: () => { window.dispatchEvent(new Event("humeditor-compile")); return true; } },
]));

function makeState(text, name) {
  const isHum = langName(name) === "hum";
  return EditorState.create({
    doc: text || "",
    extensions: [
      basicSetup,
      humTheme,
      EditorView.lineWrapping,
      syntaxHighlighting(humHighlight),
      editorKeymap,
      updateL,
      linkedMarksField,
      isHum ? humLanguage : tomlLanguage,
      // Manifest/inspection-backed completion + hover, plus compiler diagnostics.
      isHum ? humLanguage.data.of({ autocomplete: humComplete }) : [],
      isHum ? humHover : [],
      isHum ? [linter(humLint, { delay: 500 }), lintGutter()] : [],
    ],
  });
}

// Default content for a fresh untitled buffer. A minimal valid graph so the
// linter has nothing to flag on an empty editor.
const DEFAULT_HUM = "graph main {\n\n}\n";

// Start with one untitled buffer so the view always has content.
function makeBuffer(text, name, path, handle, display) {
  return {
    id: ++uid,
    path: path || null,
    name: name || "untitled.hum",
    display: display || path || name || "untitled.hum",
    handle: handle || null,
    language: langName(name),
    dirty: false,
    state: makeState(text, name),
  };
}

const first = makeBuffer(DEFAULT_HUM, "untitled.hum", null, null);
buffers.push(first);
activeId = first.id;

view = new EditorView({ state: first.state, parent: hostEl });

function textOf(b) {
  return b.id === activeId ? view.state.doc.toString() : b.state.doc.toString();
}

function activate(id) {
  // Re-activating the current buffer must NOT setState: its `b.state` is stale
  // (only refreshed on switch-away), so re-applying it would revert live edits
  // and reset undo history.  Just refocus.
  if (id === activeId) { view.focus(); return; }
  const b = buffers.find(x => x.id === id);
  if (!b) return;
  const cur = buffers.find(x => x.id === activeId);
  if (cur) cur.state = view.state;   // stash live edits before swapping
  switching = true;
  view.setState(b.state);
  switching = false;
  activeId = b.id;
  renderTabs();
  renderPath();
  refreshLinkedMarks();
  queueMicrotask(emitCursorLocation);
}

function renderPath() {
  const b = buffers.find(x => x.id === activeId);
  if (!pathEl) return;
  const p = b ? (b.display || b.path || b.name) : "";
  pathEl.textContent = p;
  pathEl.title = p;
}

function renderTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = "";
  for (const b of buffers) {
    const tab = document.createElement("div");
    tab.className = "ed-tab" + (b.id === activeId ? " active" : "");
    tab.title = b.display || b.path || b.name;   // project-qualified path on hover
    if (b.dirty) {
      const dot = document.createElement("span");
      dot.className = "ed-dirty";
      dot.textContent = "●";
      tab.appendChild(dot);
    }
    const label = document.createElement("span");
    label.textContent = b.name;
    tab.appendChild(label);
    const close = document.createElement("span");
    close.className = "ed-close";
    close.textContent = "×";
    close.title = "Close";
    close.onclick = e => { e.stopPropagation(); closeBuffer(b.id); };
    tab.appendChild(close);
    tab.onclick = () => { activate(b.id); view.focus(); };
    tabsEl.appendChild(tab);
  }
}

function closeBuffer(id) {
  const idx = buffers.findIndex(x => x.id === id);
  if (idx < 0) return;
  const b = buffers[idx];
  if (b.dirty && !confirm(`Discard unsaved changes in ${b.name}?`)) return;
  buffers.splice(idx, 1);
  if (activeId === id) {
    activeId = null;
    const next = buffers[idx] || buffers[idx - 1] || null;
    if (next) activate(next.id);
    else activate((buffers.push(makeBuffer(DEFAULT_HUM, "untitled.hum")), buffers[buffers.length - 1]).id);
  } else {
    renderTabs();
  }
}

renderTabs();
renderPath();

// ── Bridge (called by the classic-script controller) ──────────────────────────
window.humEditor = {
  apiVersion: 3,
  // Open text as a buffer. Dedups by path (re-activates an already-open file).
  // Returns the buffer id.
  openFile({ path = null, name = null, text = "", handle = null, display = null } = {}) {
    const nm = name || (path ? path.split("/").pop() : "untitled.hum");
    if (path) {
      const existing = buffers.find(x => x.path === path);
      if (existing) { activate(existing.id); return existing.id; }
    }
    const b = makeBuffer(text, nm, path, handle, display);
    buffers.push(b);
    activate(b.id);
    view.focus();
    return b.id;
  },
  // Close every open buffer whose path is in `paths`.  Used when switching
  // projects: a new project's files share root-relative paths (hum.toml,
  // src/main.hum) with the previous one, and openFile() dedups by path — so
  // without closing the old tabs first, the new project would re-activate the
  // old buffers and compile the wrong content.  One combined unsaved-changes
  // prompt; returns false (closing nothing) if the user cancels.  Always leaves
  // at least one buffer open.
  closePaths(paths) {
    const set = new Set(paths || []);
    const doomed = buffers.filter(b => b.path && set.has(b.path));
    if (!doomed.length) return true;
    if (doomed.some(b => b.dirty) &&
        !confirm("Discard unsaved changes in the current project?")) return false;
    const activeDoomed = doomed.some(b => b.id === activeId);
    const doomedIds = new Set(doomed.map(b => b.id));
    for (let i = buffers.length - 1; i >= 0; i--)
      if (doomedIds.has(buffers[i].id)) buffers.splice(i, 1);
    if (activeDoomed) {
      activeId = null;                                  // don't stash a discarded buffer
      if (!buffers.length) buffers.push(makeBuffer(DEFAULT_HUM, "untitled.hum"));
      activate(buffers[0].id);
    }
    renderTabs();
    renderPath();
    return true;
  },
  getActive() {
    const b = buffers.find(x => x.id === activeId);
    if (!b) return null;
    return { id: b.id, path: b.path, name: b.name, language: b.language, dirty: b.dirty, handle: b.handle, text: textOf(b) };
  },
  getBuffers() {
    return buffers.map(b => ({ id: b.id, path: b.path, name: b.name, language: b.language, dirty: b.dirty, handle: b.handle, text: textOf(b) }));
  },
  // Post-save: clear dirty and optionally update path/name/handle (Save As).
  markSaved(id, { path, name, handle } = {}) {
    const b = buffers.find(x => x.id === id);
    if (!b) return;
    if (path !== undefined)   b.path = path;
    if (name !== undefined) { b.name = name; b.language = langName(name); }
    if (handle !== undefined) b.handle = handle;
    // After a Save As the file leaves its old project context, so the tooltip /
    // breadcrumb should track the new path/name rather than the stale display.
    if (path !== undefined || name !== undefined) b.display = b.path || b.name;
    b.dirty = false;
    renderTabs();
    renderPath();
  },
  hasDirty() { return buffers.some(b => b.dirty); },
  focus() { view.requestMeasure(); view.focus(); },
  getCursorLocation() { return cursorLocation(); },
  // Reveal a compiler-owned source span. Paths are project-root-relative when a
  // project is open. For standalone source, fall back to basename / the only
  // open .hum buffer because compile_source() intentionally names it main.hum.
  revealLocation({ path = null, line = 1, column = 1, endLine = null, endColumn = null } = {}) {
    const norm = x => String(x || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const want = norm(path);
    let b = buffers.find(x => norm(x.path || x.name) === want);
    if (!b && want) {
      const base = want.split("/").pop();
      const matches = buffers.filter(x => norm(x.path || x.name).split("/").pop() === base);
      if (matches.length === 1) b = matches[0];
    }
    if (!b) {
      const hums = buffers.filter(x => x.language === "hum");
      if (hums.length === 1) b = hums[0];
    }
    if (!b) return false;

    muteCursorEvents = true;
    activate(b.id);
    const doc = view.state.doc;
    const lineNo = Math.min(Math.max(Number(line) || 1, 1), doc.lines);
    const startLine = doc.line(lineNo);
    const from = Math.min(startLine.from + Math.max((Number(column) || 1) - 1, 0), startLine.to);
    let to = from;
    if (endLine !== null && endLine !== undefined) {
      const endNo = Math.min(Math.max(Number(endLine) || lineNo, 1), doc.lines);
      const endObj = doc.line(endNo);
      to = Math.min(endObj.from + Math.max((Number(endColumn) || 1) - 1, 0), endObj.to);
      if (to < from) to = from;
    }
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
    // The graph initiated this reveal. Don't immediately collapse a multi-node
    // selection via the editor's selectionSet notification.
    queueMicrotask(() => { muteCursorEvents = false; });
    return true;
  },
  // Compiler-owned semantic data supplied by the controller.
  setNodeIndex(list) { nodeIndex = Array.isArray(list) ? list : []; rebuildNodeLookup(); },
  setInspection(model) { inspectionModel = model && typeof model === "object" ? model : null; },
  setLinkedSelections(spans) {
    linkedSourceSpans = Array.isArray(spans) ? spans : [];
    refreshLinkedMarks();
  },
  // Diagnostics callback (path, text) => Promise<rawDiag[]>, set by the controller.
  setChecker(fn) { checker = typeof fn === "function" ? fn : null; },
};

window.dispatchEvent(new Event("humeditor-ready"));
