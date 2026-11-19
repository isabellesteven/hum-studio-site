// hum_tune.worker.js — in-browser hum compiler running off the UI thread.
//
// Loads Pyodide + the hum wheel once (lazily on the first compile), then turns
// `.hum` source or a mirrored project folder into the same artifacts hum_tune
// already consumes: tuning JSON, the semantic inspection model, and a .humblob.
//
// The compiler is the canonical Python toolchain (hum.browser), NOT a JS
// reimplementation — so the blob byte layout and its blob_checksum agree with
// the emitted tuning JSON by construction.
//
// Message protocol (see hum_tune.html worker glue):
//   main → worker:
//     { type:'compileSource',  source, sampleRate?, block? }
//     { type:'compileProject', files:{ relpath: string|Uint8Array }, entryDir? }
//     { type:'listNodes' }                       // bundled node manifests for autocomplete
//     { type:'checkSource',  id, source, sampleRate?, block? }   // editor linter
//     { type:'checkProject', id, files:{ relpath: string|Uint8Array } }
//   worker → main:
//     { type:'progress', msg }
//     { type:'ready', buildInfo }
//     { type:'result', blob /*ArrayBuffer, transferred*/, tuning, inspection,
//                       warnings, paramsH, map }
//     { type:'error', phase, errors:[ ... ] }
//     { type:'nodes', nodes:[ ... ] }            // or { type:'nodes', error }
//     { type:'diagnostics', id, diagnostics:[ {code,message,file?,line?,column?,...} ] }

'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
// PYODIDE_INDEX_URL must point at a published Pyodide release on the CDN.
// (Note: serve/index.html references "v314.0.0", which is not a real Pyodide
// version — use a valid one here, e.g. v0.26.4.) The generated browser_dist/
// directory is resolved relative to this worker's location.
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const DIST_MANIFEST_URL = new URL('./browser_dist/browser_dist.json', self.location.href).href;
const PROJECT_DIR = '/proj';

let pyodide = null;
let ready = null;   // Promise resolved once Pyodide + wheel are loaded
let buildInfo = null;

function progress(msg) { self.postMessage({ type: 'progress', msg }); }

// Python helpers defined once; each returns a plain dict (never raises across
// the boundary) so JS can branch on `.ok`. `bytes` -> Uint8Array under toJs.
const PY_SETUP = `
import json
from hum.browser import compile_source, compile_project, bundled_namespaces, bundled_pkg_dirs

def _payload(res):
    return {
        "ok": True,
        "blob": res.blob,                 # bytes -> Uint8Array via toJs
        "tuning": json.dumps(res.tuning),
        "inspection": res.inspection.to_json(indent=None),
        "warnings": list(res.warnings),
        "paramsH": res.params_h,
        "map": res.map,
    }

def _err(exc):
    try:
        from hum.errors import CompileError
        if isinstance(exc, CompileError):
            return {"ok": False, "phase": "compile",
                    "errors": [str(e) for e in exc.errors]}
    except Exception:
        pass
    return {"ok": False, "phase": "compile",
            "errors": ["%s: %s" % (type(exc).__name__, exc)]}

def compile_source_safe(source, sample_rate, fundamental_block):
    try:
        res = compile_source(source, namespaces=bundled_namespaces(),
                             sample_rate=int(sample_rate),
                             fundamental_block=int(fundamental_block))
        return _payload(res)
    except Exception as exc:
        return _err(exc)

def compile_project_safe(path):
    try:
        return _payload(compile_project(path))
    except Exception as exc:
        return _err(exc)

def list_nodes_safe():
    # Serialize every bundled stdlib node manifest to JSON-able dicts for the
    # editor's autocomplete.  Source of truth = the same manifests the compiler
    # uses, so completions never drift from what compiles.
    try:
        from hum.manifest import load_package
        nss  = bundled_namespaces()
        dirs = bundled_pkg_dirs(nss)
        out = []
        for ns in nss:
            for m in load_package(dirs[ns]).values():
                out.append({
                    "name": m.name, "fqn": m.fqn, "namespace": m.namespace,
                    "description": m.description,
                    "inputs":  [{"name": p.name, "type": p.data_type.value,
                                 "channels": p.channels, "block_size": p.block_size,
                                 "variadic": p.count == "variable", "min_count": p.min_count,
                                 "max_count": p.max_count} for p in m.inputs],
                    "outputs": [{"name": p.name, "type": p.data_type.value,
                                 "channels": p.channels, "block_size": p.block_size,
                                 "variadic": p.count == "variable", "min_count": p.min_count,
                                 "max_count": p.max_count} for p in m.outputs],
                    "params":  [{"name": p.name, "type": p.param_type, "default": p.default,
                                 "min": p.min_val, "max": p.max_val, "mutable": p.mutable.value,
                                 "source": getattr(p, "source", None)}
                                for p in m.params],
                })
        return {"ok": True, "nodes": out}
    except Exception as exc:
        return {"ok": False, "errors": ["%s: %s" % (type(exc).__name__, exc)]}

# ── Diagnostics (editor linter) ───────────────────────────────────────────────
# Run the real compile pipeline and turn its errors into structured, source-
# located diagnostics for the editor.  HumError.to_dict() already carries
# {code,message,file,line,column,...}; lark parse errors propagate raw and carry
# .line/.column, so they are handled separately.
def _diagnostics(exc):
    from hum.errors import CompileError
    if isinstance(exc, CompileError):
        return [e.to_dict() for e in exc.errors]
    try:
        from lark.exceptions import UnexpectedInput
        if isinstance(exc, UnexpectedInput):
            # No "file": a parse error aborts the whole compile, so it always
            # belongs to the .hum being checked.  Leaving file unset lets the
            # controller's project-mode filter keep it (it only drops diagnostics
            # whose file is set and doesn't match the active buffer).
            return [{"code": "E020",
                     "message": (str(exc).strip().split("\\n")[0] or "syntax error"),
                     "line": getattr(exc, "line", 1) or 1,
                     "column": getattr(exc, "column", 1) or 1}]
    except Exception:
        pass
    return [{"code": "E000", "message": "%s: %s" % (type(exc).__name__, exc),
             "line": 1, "column": 1}]

def check_source_safe(source, sample_rate, fundamental_block):
    try:
        compile_source(source, namespaces=bundled_namespaces(),
                       sample_rate=int(sample_rate), fundamental_block=int(fundamental_block))
        return {"diagnostics": []}
    except Exception as exc:
        return {"diagnostics": _diagnostics(exc)}

def check_project_safe(path):
    try:
        compile_project(path)
        return {"diagnostics": []}
    except Exception as exc:
        diags = _diagnostics(exc)
        # Make every diagnostic's file PROJECT-RELATIVE (strip the MEMFS root) and
        # default location-less ones to the entry, so the editor can match a
        # diagnostic to a buffer by exact path instead of a fragile suffix test.
        root = path.rstrip("/") + "/"
        def rel(p):
            p = str(p)
            return p[len(root):] if p.startswith(root) else p
        entry_rel = None
        try:
            from hum.project import load_project
            from pathlib import Path
            entry_rel = rel(load_project(Path(path)).entry)
        except Exception:
            pass
        for d in diags:
            if d.get("file"):
                d["file"] = rel(d["file"])
            elif entry_rel:
                d["file"] = entry_rel
        return {"diagnostics": diags}
`;

async function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    progress('Loading Pyodide…');
    importScripts(PYODIDE_INDEX_URL + 'pyodide.js');
    pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });

    progress('Installing hum compiler…');
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');

    // The CMake/Python browser build emits a stable manifest that names the
    // exact wheel and fingerprints the compiler + stdlib used to create it.
    // Fetch both with cache disabled, then verify the wheel bytes before install.
    const manifestResp = await fetch(DIST_MANIFEST_URL, { cache: 'no-store' });
    if (!manifestResp.ok) {
      throw new Error(`browser compiler manifest not found (${manifestResp.status}). ` +
                      `Build it with the browser_dist target.`);
    }
    buildInfo = await manifestResp.json();
    if (!buildInfo || !buildInfo.wheel) throw new Error('invalid browser_dist.json: missing wheel');

    const wheelUrl = new URL('./browser_dist/' + buildInfo.wheel, self.location.href).href;
    const resp = await fetch(wheelUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`wheel fetch failed: ${resp.status} ${resp.statusText}`);
    const wheelBytes = new Uint8Array(await resp.arrayBuffer());

    if (buildInfo.wheel_sha256 && self.crypto && self.crypto.subtle) {
      const digest = await self.crypto.subtle.digest('SHA-256', wheelBytes);
      const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (actual.toLowerCase() !== String(buildInfo.wheel_sha256).toLowerCase())
        throw new Error(`browser compiler wheel checksum mismatch: expected ${buildInfo.wheel_sha256}, got ${actual}`);
    }

    const wheelPath = '/tmp/' + buildInfo.wheel;
    pyodide.FS.writeFile(wheelPath, wheelBytes);
    await micropip.install('emfs:' + wheelPath);   // deps (lark) still pulled from PyPI
    micropip.destroy();

    pyodide.runPython(PY_SETUP);
    self.postMessage({ type: 'ready', buildInfo });
    progress('Compiler ready.');
  })();
  return ready;
}

// Convert a Python payload proxy into a transferable worker message.
function postPayload(payloadProxy) {
  const p = payloadProxy.toJs({ dict_converter: Object.fromEntries });
  payloadProxy.destroy();

  if (!p.ok) {
    self.postMessage({ type: 'error', phase: p.phase || 'compile', errors: p.errors });
    return;
  }
  const blobBuf = p.blob.buffer;   // Uint8Array (copy of Python bytes)
  self.postMessage({
    type: 'result',
    blob: blobBuf,
    tuning: p.tuning,
    inspection: p.inspection,
    warnings: p.warnings,
    paramsH: p.paramsH,
    map: p.map,
  }, [blobBuf]);
}

// Mirror the project into MEMFS incrementally.  The debounced linter calls this
// on every edit-pause, so a full rmtree + rewrite-everything (re-copying large
// binary load() assets each time) would be wasteful.  We track what was last
// written and only (re)write changed entries, unlinking ones that disappeared.
// Unchanged files keep the same reference (only open text buffers get fresh
// strings), so binaries and untouched files are skipped via the identity check.
let _fsCache = {};   // relpath -> last-written content
function writeProjectFiles(files) {
  const FS = pyodide.FS;
  const enc = new TextEncoder();
  for (const rel of Object.keys(_fsCache)) {
    if (!(rel in files)) {
      try { FS.unlink(PROJECT_DIR + '/' + rel.replace(/^\/+/, '')); } catch (_) {}
      delete _fsCache[rel];
    }
  }
  for (const [rel, content] of Object.entries(files)) {
    if (_fsCache[rel] === content) continue;   // unchanged since last write
    const full = PROJECT_DIR + '/' + rel.replace(/^\/+/, '');
    const slash = full.lastIndexOf('/');
    if (slash > 0) FS.mkdirTree(full.slice(0, slash));
    // Encode text to UTF-8 bytes explicitly (Python reads these as utf-8).
    const bytes = (typeof content === 'string') ? enc.encode(content) : content;
    FS.writeFile(full, bytes);
    _fsCache[rel] = content;
  }
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  const isCheck = m.type === 'checkSource' || m.type === 'checkProject';
  try {
    await ensureReady();
  } catch (e) {
    // A background check must never hijack the compile UI or hang its promise:
    // reply on its own channel (empty = degrade gracefully).  listNodes likewise.
    if (isCheck)                      self.postMessage({ type: 'diagnostics', id: m.id, diagnostics: [] });
    else if (m.type === 'listNodes')  self.postMessage({ type: 'nodes', error: '' + (e && e.message || e) });
    else                              self.postMessage({ type: 'error', phase: 'init', errors: ['' + (e && e.message || e)] });
    return;
  }

  try {
    if (m.type === 'compileSource') {
      progress('Compiling…');
      const fn = pyodide.globals.get('compile_source_safe');
      const payload = fn(m.source, m.sampleRate || 48000, m.block || 256);
      fn.destroy();
      postPayload(payload);
    } else if (m.type === 'compileProject') {
      progress('Compiling project…');
      writeProjectFiles(m.files || {});
      const fn = pyodide.globals.get('compile_project_safe');
      const payload = fn(PROJECT_DIR);
      fn.destroy();
      postPayload(payload);
    } else if (m.type === 'listNodes') {
      const fn = pyodide.globals.get('list_nodes_safe');
      const proxy = fn();
      fn.destroy();
      const p = proxy.toJs({ dict_converter: Object.fromEntries });
      proxy.destroy();
      if (p.ok) self.postMessage({ type: 'nodes', nodes: p.nodes });
      else      self.postMessage({ type: 'nodes', error: (p.errors || []).join('; ') });
    } else if (m.type === 'checkSource' || m.type === 'checkProject') {
      let proxy;
      if (m.type === 'checkProject') {
        writeProjectFiles(m.files || {});
        const fn = pyodide.globals.get('check_project_safe');
        proxy = fn(PROJECT_DIR);
        fn.destroy();
      } else {
        const fn = pyodide.globals.get('check_source_safe');
        proxy = fn(m.source, m.sampleRate || 48000, m.block || 256);
        fn.destroy();
      }
      const p = proxy.toJs({ dict_converter: Object.fromEntries });
      proxy.destroy();
      self.postMessage({ type: 'diagnostics', id: m.id, diagnostics: p.diagnostics || [] });
    }
  } catch (e) {
    // Unexpected JS-side failure (FS, proxy, transfer).  Keep a background check
    // on its own channel so it can't masquerade as a compile failure.
    if (isCheck) self.postMessage({ type: 'diagnostics', id: m.id, diagnostics: [] });
    else         self.postMessage({ type: 'error', phase: 'worker', errors: ['' + (e && e.message || e)] });
  }
};
