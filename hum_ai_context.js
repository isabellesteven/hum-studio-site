/* Hum Studio AI Context exporter (Phase 4.1).
 * Builds a provider-neutral Markdown handoff from editor buffers, compiler-owned
 * inspection, and compiler-owned node manifests. No network/API/file I/O.
 * CommonJS is supported for deterministic Node regression tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HumAIContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';
  const MAX_SOURCE_CHARS = 180000;
  const MAX_MANIFESTS = 128;
  const MAX_SELECTED_ENTITIES = 50;

  const norm = value => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const sourceFile = path => /\.(?:hum|toml)$/i.test(path);
  const lines = arr => arr.join('\n');
  const fence = value => {
    const matches = String(value).match(/`+/g) || [];
    const widest = matches.reduce((n, x) => Math.max(n, x.length), 0);
    return '`'.repeat(Math.max(3, widest + 1));
  };
  function codeBlock(content, language) {
    const mark = fence(content);
    return `${mark}${language || ''}\n${content}\n${mark}`;
  }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function location(span) {
    if (!span) return '';
    const file = norm(span.file || span.path);
    const line = Number(span.line);
    const col = Number(span.column);
    return file ? `${file}${line > 0 ? ':' + line : ''}${col > 0 ? ':' + col : ''}` : '';
  }
  function briefPin(pin) {
    const extras = [pin.type || pin.data_type, pin.channels != null ? `ch=${pin.channels}` : null,
      pin.variadic ? 'variadic' : null].filter(Boolean);
    return `${pin.name || '?'}${extras.length ? ' (' + extras.join(', ') + ')' : ''}`;
  }
  function manifestText(m) {
    const rows = [`- ${m.fqn || m.name}${m.description ? ' — ' + String(m.description).replace(/\s+/g, ' ').slice(0, 180) : ''}`];
    for (const [label, members, fn] of [
      ['inputs', m.inputs, briefPin], ['outputs', m.outputs, briefPin],
      ['parameters', m.params, p => {
        const extra = [p.type, p.mutable, p.default !== undefined && p.default !== null ? `default=${JSON.stringify(p.default)}` : null,
          p.min != null ? `min=${p.min}` : null, p.max != null ? `max=${p.max}` : null,
          p.source ? `compiler-owned=${p.source}` : null].filter(Boolean);
        return `${p.name}${extra.length ? ' (' + extra.join(', ') + ')' : ''}`;
      }],
    ]) if (asArray(members).length) rows.push(`  - ${label}: ${members.map(fn).join('; ')}`);
    return rows.join('\n');
  }
  // A compact *complete* discovery catalog lets a model identify new types
  // (such as BiquadHP) even though they do not appear in the current graph.
  // Exact contracts follow for referenced types, or the entire library when
  // the user chooses Full. All entries come from the compiler's node index.
  function compactCatalog(nodeIndex) {
    const groups = new Map();
    for (const m of nodeIndex) {
      if (!m || !m.name) continue;
      const ns = m.namespace || String(m.fqn || '').split('.').slice(0, -1).join('.') || '(no namespace)';
      if (!groups.has(ns)) groups.set(ns, []);
      groups.get(ns).push(m);
    }
    const result = [];
    for (const ns of [...groups.keys()].sort()) {
      result.push(`### ${ns}`);
      for (const m of groups.get(ns).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        const ins = asArray(m.inputs).map(p => p.name + (p.variadic ? '[n]' : '')).join(', ') || 'none';
        const outs = asArray(m.outputs).map(p => p.name + (p.variadic ? '[n]' : '')).join(', ') || 'none';
        const tunables = asArray(m.params).filter(p => !p.source && (p.mutable === 'param' || p.mutable === 'array'))
          .map(p => `${p.name}${p.mutable === 'array' ? '@array' : '@param'}`);
        result.push(`- **${m.name}**: in[${ins}] → out[${outs}]${tunables.length ? '; tunable: ' + tunables.join(', ') : ''}`);
      }
      result.push('');
    }
    return result;
  }
  function resolveReferencedManifests(nodeIndex, source, selection, inspection) {
    const requestedTypes = new Set();
    for (const match of source.matchAll(/\bnode\s+[A-Za-z_][\w]*\s*:\s*([A-Za-z_][\w.]*)/g)) requestedTypes.add(match[1]);
    for (const id of asArray(selection?.nodeIds)) {
      if (id.startsWith('node:')) {
        const n = asArray(inspection?.nodes).find(n => String(n.runtime_node_id) === id.slice(5));
        if (n) requestedTypes.add(n.fqn || n.type_name);
      } else if (id.startsWith('subgraph:')) {
        const prefix = id.slice(9) + '.';
        for (const n of asArray(inspection?.nodes))
          if (String(n.instance_path || '').startsWith(prefix)) requestedTypes.add(n.fqn || n.type_name);
      }
    }
    const imports = new Set([...source.matchAll(/\bimport\s+["']([A-Za-z_][\w.]*)["']/g)].map(m => m[1]));
    const matches = nodeIndex.filter(m => {
      if (!m?.name && !m?.fqn) return false;
      const fqn = m.fqn || m.name;
      if (requestedTypes.has(fqn)) return true;
      if (!requestedTypes.has(m.name)) return false;
      return !m.namespace || imports.has(m.namespace) || imports.has(fqn);
    }).sort((a, b) => String(a.fqn || a.name).localeCompare(String(b.fqn || b.name)));
    const declaredGraphs = new Set([...source.matchAll(/\bgraph\s+([A-Za-z_]\w*)/g)].map(m => m[1]));
    const missing = [...requestedTypes].filter(t => !matches.some(m => m.fqn === t || m.name === t) && !declaredGraphs.has(t));
    return { matches, missing };
  }
  function selectionText(selection, inspection) {
    const ids = asArray(selection?.nodeIds);
    const out = [];
    const nodes = asArray(inspection?.nodes);
    const subs = asArray(inspection?.subgraphs);
    const conns = asArray(inspection?.connections);
    const inputs = asArray(inspection?.graph_inputs);
    const outputs = asArray(inspection?.graph_outputs);
    for (const id of ids.slice(0, MAX_SELECTED_ENTITIES)) {
      if (id.startsWith('node:')) {
        const n = nodes.find(n => String(n.runtime_node_id) === id.slice(5));
        out.push(n
          ? `- Node ${n.instance_path || n.instance_name} : ${n.fqn || n.type_name || 'unknown'}${location(n.source) ? ' @ ' + location(n.source) : ''}`
          : `- Node ${id} (not found in current inspection)`);
      } else if (id.startsWith('subgraph:')) {
        const path = id.slice(9);
        const sub = subs.find(s => s.instance_path === path);
        const descendants = nodes.filter(n => String(n.instance_path || '').startsWith(path + '.'));
        out.push(`- Subgraph ${path}${sub?.type_name ? ' : ' + sub.type_name : ''} (${descendants.length} descendant runtime nodes)${location(sub?.source) ? ' @ ' + location(sub.source) : ''}`);
      } else if (id.startsWith('gin:') || id.startsWith('gout:')) {
        const input = id.startsWith('gin:');
        const pin = (input ? inputs : outputs)[Number(id.split(':')[1])];
        out.push(`- Graph ${input ? 'input' : 'output'}: ${pin?.name || id}`);
      } else out.push(`- ${id}`);
    }
    if (ids.length > MAX_SELECTED_ENTITIES) out.push(`- (${ids.length - MAX_SELECTED_ENTITIES} more selected nodes omitted)`);
    if (selection?.connectionId != null) {
      const c = conns.find(c => String(c.connection_id) === String(selection.connectionId));
      const describe = ep => ep ? [ep.instance_path, ep.pin_name].filter(Boolean).join('.') || ep.kind || '?' : '?';
      out.push(c ? `- Connection ${c.connection_id}: ${describe(c.source_endpoint)} → ${describe(c.destination_endpoint)}${location(c.source) ? ' @ ' + location(c.source) : ''}`
        : `- Connection ${selection.connectionId} (not found in current inspection)`);
    }
    return out.length ? lines(out) : 'No graph entity selected.';
  }
  function buildContext({ files, activePath, scope = 'focused', inspection = null,
                          selection = null, nodeIndex = [], diagnostics = null,
                          diagnosticsCurrent = false, buildName = null,
                          languageReference = null, catalogDetail = 'relevant' } = {}) {
    if (!['focused', 'project'].includes(scope)) throw new Error('Invalid AI context scope.');
    if (!['relevant', 'full'].includes(catalogDetail)) throw new Error('Invalid node catalog detail.');
    if (!languageReference?.text || !languageReference?.version)
      throw new Error('Hum V1 language reference is unavailable. Reload Hum Studio.');
    const fileMap = new Map();
    for (const entry of asArray(files)) {
      const path = norm(entry?.path);
      if (sourceFile(path) && typeof entry.text === 'string') fileMap.set(path, entry.text);
    }
    if (!fileMap.size) throw new Error('Open a .hum file or a Hum project before exporting context.');
    const active = norm(activePath);
    const allPaths = [...fileMap.keys()].sort((a, b) => a.localeCompare(b));
    let included;
    if (scope === 'project') included = allPaths;
    else {
      // Focused scope uses the active buffer plus the root manifest (if present).
      // When the active file is hum.toml, prefer the compiler's entry or main.hum.
      let main = active;
      if (!main.endsWith('.hum')) {
        const compiledEntry = norm(inspection?.project?.entry);
        main = allPaths.includes(compiledEntry) ? compiledEntry :
          allPaths.find(p => p.endsWith('/main.hum') || p === 'main.hum') ||
          allPaths.find(p => p.endsWith('.hum')) || '';
      }
      included = [main, 'hum.toml', active].filter(p => fileMap.has(p));
      included = [...new Set(included)];
    }
    if (!included.length) throw new Error('No readable source in this scope.');
    const charCount = included.reduce((n, p) => n + fileMap.get(p).length, 0);
    if (charCount > MAX_SOURCE_CHARS) throw new Error(`Source is ${charCount.toLocaleString()} characters; context limit is ${MAX_SOURCE_CHARS.toLocaleString()}. Select Focused scope or reduce project size.`);

    const src = included.map(p => fileMap.get(p)).join('\n');
    const nodes = asArray(nodeIndex).filter(m => m?.fqn && m?.name);
    const { matches, missing } = resolveReferencedManifests(nodes, src, selection, inspection);
    const selectedManifests = catalogDetail === 'full' ? [...nodes].sort((a, b) =>
      String(a.fqn).localeCompare(String(b.fqn))) : matches;
    if (selectedManifests.length > MAX_MANIFESTS)
      throw new Error(`Node catalog contains ${selectedManifests.length} manifests; maximum is ${MAX_MANIFESTS}.`);
    const omittedPaths = allPaths.filter(p => !included.includes(p));
    const staleWarning = inspection
      ? 'Inspection data is from the last loaded/compiled build and may not reflect unsaved source changes.'
      : 'No inspection data loaded. Graph selection and semantic information may be incomplete.';
    const result = [
      '# Hum AI Context',
      '',
      'This is an engineering handoff, not validated code. Suggest changes to the editable Hum source and manifests; the Hum compiler is the authority on validity.',
      '',
      '## Task',
      'Describe the requested modification to this project:',
      '',
      '> [Enter your requested change here]',
      '',
      '## Project and export scope',
      `- Project/build: ${buildName || '(not named)'}`,
      `- Export scope: ${scope === 'project' ? 'all project source' : 'focused (active graph and root manifest)'}`,
      `- Active editor file: ${active || '(none)'}`,
      `- Included files: ${included.join(', ')}`,
      `- Other project source files: ${omittedPaths.length ? omittedPaths.join(', ') : '(none)'}`,
      '- All included text reflects the current editor buffers, including unsaved edits.',
      `- AI language reference: ${languageReference.version} (${languageReference.sha256?.slice(0, 12) || 'no digest'}).`,
      `- Node catalog detail: ${catalogDetail === 'full' ? 'full contracts for all bundled nodes' : 'compact full index plus detailed relevant contracts'}.`,
      `- ${staleWarning}`,
      '',
      '## Hum language and project reference (V1)',
      languageReference.text.trim(),
      '',
      '## Bundled node catalog (all compiler-known built-ins)',
      'The following discovery index covers all node types in the currently loaded browser compiler; use exact names and package imports. It does not promise that every host contains every C implementation.',
    ];
    if (!nodes.length) result.push('⚠ **Incomplete context:** compiler node index is unavailable. Do not guess node interfaces. Compile/open the editor to load the node index and re-export.');
    else result.push(...compactCatalog(nodes));
    result.push('## Detailed node contracts',
      catalogDetail === 'full'
        ? 'Complete bundled node catalog, including defaults, allowed mutability, and compiler-owned parameters.'
        : 'Exact contracts for node types already used in the included source or selected graph. For new types, the discovery catalog lists their pins and tunable parameter names; choose Full catalog for parameter defaults, types, ranges, and const parameters.');
    if (!selectedManifests.length) result.push('No matching detailed bundled node contracts are available.');
    else result.push(...selectedManifests.map(manifestText));
    if (missing.length) result.push(`\n⚠ Node/subgraph types without a bundled contract in this export: ${missing.join(', ')}. They may come from custom packages or omitted project files; request their manifests instead of guessing.`);
    result.push('', '## Selected graph entities (from compiler inspection)',
      selectionText(selection, inspection), '',
      '## Current source');
    for (const p of included) {
      result.push('', `### ${p}`, codeBlock(fileMap.get(p), p.endsWith('.toml') ? 'toml' : 'hum'));
    }
    result.push('', '## Compiler diagnostics');
    if (diagnosticsCurrent) {
      if (!asArray(diagnostics).length) result.push('No errors were reported by the most recent compiler check for these exact source buffers.');
      else for (const d of diagnostics) {
        const where = [norm(d.file), d.line, d.column].filter(x => x != null && x !== '').join(':');
        result.push(`- ${where ? where + ' ' : ''}${d.code ? '[' + d.code + '] ' : ''}${d.message || String(d)}`);
        for (const hint of [...asArray(d.notes), ...asArray(d.hints)]) result.push(`  - ${hint}`);
      }
    } else result.push('No verified current diagnostics available. Run Compile to validate any proposed change.');
    result.push('', '## Hum authoring constraints',
      '- Hum source (`.hum`) is the canonical text; graph visualization is for inspection/navigation, not authoring.',
      '- Use imports and valid node manifests; update `hum.toml` dependencies when needed.',
      '- Maintain existing declared graph inputs, outputs, and intended signal flow unless the task calls for changes.',
      '- Preserve Hum V1 single-rate, graph block-size conventions and Source/Sink I/O conventions.',
      '- Do not invent node types, ports, parameters, or compiler features; ask for missing manifests when needed.',
      '- Return proposed edits as complete file contents or explicit per-file patches, identifying each relative path.',
      '- The user will apply edits and recompile in Hum Studio; a model response is not an executable artifact.',
      '');
    return { text: result.join('\n'), includedFiles: included, omittedFiles: omittedPaths,
      selectedManifestCount: selectedManifests.length, catalogNodeCount: nodes.length,
      catalogDetail, languageReferenceVersion: languageReference.version, characterCount: charCount };
  }
  return { buildContext, MAX_SOURCE_CHARS };
});
