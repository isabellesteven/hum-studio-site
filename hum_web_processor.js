/* hum_web_processor.js — AudioWorklet host for the CANONICAL Hum C runtime.
 * Only transport, 128-frame/block adaptation, and control-message handling
 * live here; there is no JavaScript DSP or duplicate blob interpretation.
 *
 * Compiled hum_web.wasm is a standalone WebAssembly module (emcc --no-entry).
 * It exports the C shim functions from host/hum_web/hum_web.c and memory.
 */
'use strict';

class HumWebProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.exports = null;
    this.memory = null;
    this.block = 0;
    this.inChannels = 0;
    this.outChannels = 0;
    this.inputPtr = 0;
    this.outputPtr = 0;
    this.valuePtr = 0;
    this.memoryF32 = null;
    this.inputUsed = 0;
    this.outputUsed = 0;
    this.outputRead = 0;
    this.generation = 0;
    this.tuningParams = [];
    this.port.onmessage = e => { this.handleMessage(e.data || {}); };
  }

  fn(name) {
    const f = this.exports?.[name] || this.exports?.['_' + name];
    if (!f) throw new Error('Missing WASM export ' + name + ' — rebuild hum_web.wasm');
    return f;
  }

  reply(lines) {
    this.port.postMessage({ type: 'lines', lines: Array.isArray(lines) ? lines : [lines] });
  }

  async handleMessage(message) {
    if (message.type === 'load') {
      const generation = ++this.generation;
      this.ready = false;
      try {
        if (!this.exports) {
          // STANDALONE_WASM emits WASI imports even for compute-only modules.
          // This host has no filesystem. Supply truthful, minimal stdio/WASI
          // functions rather than returning success for unsupported I/O.
          // WASI code is outside the real-time DSP path.
          const WASI_EBADF = 8, WASI_EFAULT = 21, WASI_ESPIPE = 70;
          const view = () => {
            if (!this.memory) throw new Error('WASI memory not initialized');
            return new DataView(this.memory.buffer);
          };
          const put32 = (ptr, value) => {
            try { view().setUint32(ptr, value >>> 0, true); return 0; }
            catch (_) { return WASI_EFAULT; }
          };
          const imports = {
            env: { abort: () => { throw new Error('WASM abort'); } },
            wasi_snapshot_preview1: {
              proc_exit: (code) => { throw new Error('WASM exit ' + code); },
              // Only stdio (fds 0, 1, 2) exists in the browser host.
              fd_close: fd => fd >= 0 && fd <= 2 ? 0 : WASI_EBADF,
              fd_seek: () => WASI_ESPIPE,
              fd_read: (fd, _iovs, _count, nread) =>
                fd === 0 ? put32(nread, 0) : WASI_EBADF, // stdin = EOF
              fd_write: (fd, iovs, count, nwritten) => {
                if (fd !== 1 && fd !== 2) return WASI_EBADF;
                try {
                  const mem = view();
                  let total = 0;
                  for (let i = 0; i < count; i++) {
                    const start = mem.getUint32(iovs + i * 8, true);
                    const size = mem.getUint32(iovs + i * 8 + 4, true);
                    if (start > mem.byteLength || size > mem.byteLength - start)
                      return WASI_EFAULT;
                    total += size;
                    if (total > 0xffffffff) return WASI_EFAULT;
                  }
                  // Acknowledge, but discard stdout/stderr to keep the audio
                  // thread free of console or message-port work.
                  return put32(nwritten, total);
                } catch (_) { return WASI_EFAULT; }
              },
              environ_get: () => 0,
              environ_sizes_get: (count, bytes) =>
                put32(count, 0) || put32(bytes, 0),
              args_get: () => 0,
              args_sizes_get: (count, bytes) =>
                put32(count, 0) || put32(bytes, 0),
              fd_fdstat_get: (fd, ptr) => {
                if (fd < 0 || fd > 2) return WASI_EBADF;
                try {
                  const mem = view();
                  for (let i = 0; i < 24; i++) mem.setUint8(ptr + i, 0);
                  mem.setUint8(ptr, 2); // WASI character device
                  return 0;
                } catch (_) { return WASI_EFAULT; }
              },
              fd_prestat_get: () => WASI_EBADF,
              fd_prestat_dir_name: () => WASI_EBADF,
            },
          };
          const result = await WebAssembly.instantiate(message.wasmBytes, imports);
          if (generation !== this.generation) return;
          this.exports = result.instance ? result.instance.exports : result.exports;
          this.memory = this.exports.memory;
          if (!this.memory) throw new Error('WASM module did not export memory');
          if (this.exports._initialize) this.exports._initialize();
          else if (this.exports.__wasm_call_ctors) this.exports.__wasm_call_ctors();
        }
        const blob = new Uint8Array(message.blob);
        const ptr = this.fn('malloc')(blob.byteLength);
        if (!ptr) throw new Error('WASM memory exhausted for blob');
        try {
          new Uint8Array(this.memory.buffer, ptr, blob.length).set(blob);
          const rc = this.fn('hum_web_load')(ptr, blob.length);
          if (rc) throw new Error('hum_web_load failed (' + rc + ')');
        } finally {
          this.fn('free')(ptr);
        }
        const io = message.bridge || {};
        const bindRc = this.fn('hum_web_bind_bridges')(
          Number.isInteger(io.sourceNode) ? io.sourceNode : -1,
          Number.isInteger(io.sourceSlots) ? io.sourceSlots : 0,
          Number.isInteger(io.sinkNode) ? io.sinkNode : -1,
          Number.isInteger(io.sinkSlots) ? io.sinkSlots : 0);
        if (bindRc !== 0) throw new Error('hum_web_bind_bridges failed (' + bindRc +
          '); load compiler inspection metadata for Source/Sink graphs');
        const block = this.fn('hum_web_block_size')();
        const rate = this.fn('hum_web_sample_rate')();
        const inputChannels = this.fn('hum_web_input_channels')();
        const outputChannels = this.fn('hum_web_output_channels')();
        if (rate !== sampleRate)
          throw new Error('Blob sample rate ' + rate + ' differs from AudioContext ' + sampleRate);
        if (!(block > 0 && block <= 4096) || outputChannels < 1 || outputChannels > 2 ||
            inputChannels < 0 || inputChannels > 2) throw new Error('Unsupported Hum block or channel count');
        // Allocations occur at load time, NEVER in process().
        if (this.inputPtr) this.fn('free')(this.inputPtr);
        if (this.outputPtr) this.fn('free')(this.outputPtr);
        if (this.valuePtr) this.fn('free')(this.valuePtr);
        this.inputPtr = this.fn('malloc')(2 * block * 4);
        this.outputPtr = this.fn('malloc')(2 * block * 4);
        this.valuePtr = this.fn('malloc')(4);
        if (!this.inputPtr || !this.outputPtr || !this.valuePtr)
          throw new Error('WASM memory exhausted for audio buffers');
        this.block = block;
        this.inChannels = inputChannels;
        this.outChannels = outputChannels;
        this.memoryF32 = new Float32Array(this.memory.buffer);
        this.inputUsed = 0;
        this.outputUsed = 0;
        this.outputRead = 0;
        this.tuningParams = (message.params || []).filter(p =>
          Number.isInteger(p.node_id) && Number.isInteger(p.param_id) &&
          p.mutable !== 'const' && p.mutable !== 'array');
        this.ready = true;
        this.port.postMessage({ type: 'loaded', id: message.id,
          block, rate, inputChannels, outputChannels });
      } catch (error) {
        this.ready = false;
        this.port.postMessage({ type: 'error', id: message.id,
          error: error.message || String(error) });
      }
    } else if (message.type === 'command') {
      this.command(message.cmd || '');
    }
  }

  command(command) {
    if (!this.ready) { this.reply('ERR not loaded'); return; }
    const words = command.trim().split(/\s+/);
    const verb = words[0];
    const node = Number(words[1]), param = Number(words[2]);
    const validId = Number.isInteger(node) && node >= 0 && Number.isInteger(param) && param >= 0;
    try {
      if (verb === 'INFO') {
        // INFO is assembled by the browser host from the real compiled blob
        // header (not from tuning JSON), so it can detect compatibility.
        this.port.postMessage({ type: 'info' });
      } else if (verb === 'SET' && validId && words.length === 4) {
        const value = Number(words[3]);
        const rc = Number.isFinite(value) ? this.fn('hum_web_set_param')(node, param, value) : -100;
        this.reply(rc === 0 ? `OK ${node} ${param} ${value}` : `ERR ${node} ${param} rc=${rc}`);
      } else if (verb === 'GET' && validId) {
        this.reply(this.getParam(node, param));
      } else if (verb === 'DUMP') {
        const lines = [];
        for (const p of this.tuningParams) lines.push(this.getParam(p.node_id, p.param_id));
        lines.push('OK DUMP');
        this.reply(lines);
      } else if (verb === 'RESET') {
        const rc = this.fn('hum_web_reset')();
        this.inputUsed = this.outputUsed = this.outputRead = 0;
        this.reply(rc === 0 ? 'OK RESET' : 'ERR reset ' + rc);
      } else if (verb === 'PROFILE') {
        // Intentionally unsupported; no fake performance numbers.
        this.reply('ERR PROFILE unavailable in hum-web V1');
      } else if (verb === 'SET_ARRAY' || verb === 'GET_ARRAY') {
        this.reply(`ERR ${validId ? node : 0} ${validId ? param : 0} array-tuning-not-supported`);
      } else {
        this.reply('ERR unsupported command');
      }
    } catch (error) {
      this.reply('ERR ' + (error.message || String(error)));
    }
  }

  getParam(node, param) {
    const rc = this.fn('hum_web_get_param')(node, param, this.valuePtr);
    if (rc !== 0) return `ERR ${node} ${param} rc=${rc}`;
    const val = this.memoryF32[this.valuePtr >>> 2];
    return `OK ${node} ${param} ${val}`;
  }

  renderBlock() {
    const rc = this.fn('hum_web_process')(this.inputPtr, this.outputPtr, this.block);
    if (rc !== 0) {
      this.ready = false;
      this.port.postMessage({ type: 'error', error: 'hum_web_process failed (' + rc + ')' });
      return false;
    }
    this.inputUsed = 0;
    this.outputUsed = this.block;
    this.outputRead = 0;
    return true;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const frames = out[0].length;
    // AudioWorklet output defaults to silence if a load is pending or failed.
    if (!this.ready) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }
    const input = inputs[0] || [];
    const data = this.memoryF32;
    const inputOffset = this.inputPtr >>> 2;
    const outputOffset = this.outputPtr >>> 2;
    // Sample streaming adapter handles any supported B, not just 128.
    // For input graphs: one block of captured input before rendering begins.
    // For generators with no input: render a block on demand immediately.
    for (let i = 0; i < frames; i++) {
      if (this.inChannels > 0) {
        for (let c = 0; c < this.inChannels; c++) {
          const source = input[c] || input[0];
          data[inputOffset + c * this.block + this.inputUsed] = source ? source[i] : 0;
        }
        this.inputUsed++;
      }
      if (this.outputUsed === 0 &&
          (this.inChannels === 0 || this.inputUsed === this.block)) {
        if (!this.renderBlock()) {
          for (let c = 0; c < out.length; c++) out[c][i] = 0;
          continue;
        }
      }
      if (this.outputUsed > 0) {
        const index = this.outputRead++;
        for (let c = 0; c < out.length; c++) {
          const src = Math.min(c, this.outChannels - 1);
          out[c][i] = data[outputOffset + src * this.block + index];
        }
        this.outputUsed--;
      } else {
        for (let c = 0; c < out.length; c++) out[c][i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('hum-web-processor', HumWebProcessor);
