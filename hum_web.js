/* hum_web.js — main-thread AudioContext integration for Hum Studio.
 * Does not implement DSP, graph semantics, or tuning state. The real C runtime
 * is in hum_web.wasm and runs exclusively in the AudioWorklet processor. */
'use strict';

(function () {
  class HumWebHost {
    constructor({ assetUrl, onLine, onError, onLoaded }) {
      this.assetUrl = assetUrl;
      this.onLine = onLine;
      this.onError = onError;
      this.onLoaded = onLoaded;
      this.ctx = null;
      this.node = null;
      this.source = null;
      this.routeGeneration = 0; // Invalidates delayed source setup after Stop/switch/disconnect.
      this.liveSource = null;
      this.liveStream = null;
      this.liveAdapter = [];
      this.liveAnalyser = null;
      this.liveMeterBuffer = null;
      this.outputDeviceId = '';
      this.outputElement = null;
      this.outputStreamDestination = null;
      this.ready = false;
      this.loadSequence = 0;
      this.pending = new Map();
      this.build = null;
      this.audioFile = null;
      this.loop = true;
      this.info = null;
      this.inputChannels = 0;
    }

    static blobHeader(blob) {
      if (!(blob instanceof ArrayBuffer) || blob.byteLength < 64) throw new Error('Missing or invalid Hum blob');
      const b = new DataView(blob);
      if (b.getUint8(0) !== 72 || b.getUint8(1) !== 85 ||
          b.getUint8(2) !== 77 || b.getUint8(3) !== 0)
        throw new Error('Not a Hum blob');
      if (b.getUint8(4) !== 2 || b.getUint8(5) !== 1)
        throw new Error('Unsupported Hum format/API version');
      if (b.getUint32(8, true) !== blob.byteLength)
        throw new Error('Incomplete Hum blob');
      return { sampleRate: b.getUint32(20, true),
        block: b.getUint16(24, true), nodes: b.getUint16(26, true),
        params: b.getUint16(30, true), checksum: b.getUint32(36, true) };
    }

    static bridgeFromInspection(inspection) {
      const nodes = inspection?.nodes || [];
      const sourceNodes = nodes.filter(n => n.fqn === 'std.io.Source');
      const sinkNodes = nodes.filter(n => n.fqn === 'std.io.Sink');
      if (sourceNodes.length > 1 || sinkNodes.length > 1)
        throw new Error('hum-web V1 requires at most one Source and one Sink bridge');
      function slots(node, direction) {
        if (!node) return 0;
        return (node[direction] || []).reduce((n,p) =>
          n + (p.variadic ? Number(p.resolved_count || 1) : 1), 0);
      }
      const source = sourceNodes[0], sink = sinkNodes[0];
      return {
        sourceNode: source ? Number(source.runtime_node_id) : -1,
        sourceSlots: slots(source, 'outputs'),
        sinkNode: sink ? Number(sink.runtime_node_id) : -1,
        sinkSlots: slots(sink, 'inputs'),
      };
    }

    async connect(blob, tuning, inspection) {
      const header = HumWebHost.blobHeader(blob);
      if (!window.AudioContext || !window.AudioWorkletNode)
        throw new Error('AudioWorklet requires a current Chrome, Edge, Firefox, or Safari over localhost/HTTPS');
      if (this.ctx) await this.disconnect();
      this.ctx = new AudioContext({ sampleRate: header.sampleRate, latencyHint: 'interactive' });
      try {
        if (this.ctx.sampleRate !== header.sampleRate)
          throw new Error(`Browser audio rate ${this.ctx.sampleRate} != graph ${header.sampleRate}. Recompile graph at ${this.ctx.sampleRate} Hz.`);
        // Resume in direct response to user interaction (browser autoplay policy).
        await this.ctx.resume();
        if (this.ctx.state !== 'running')
          throw new Error('AudioContext is suspended; click Connect again after enabling audio');
        const wasmResponse = await fetch(this.assetUrl('hum_web.wasm'), { cache: 'no-cache' });
        if (!wasmResponse.ok)
          throw new Error('hum_web.wasm missing — run host/hum_web/build_wasm.sh or build_wasm.ps1');
        this.wasmBytes = await wasmResponse.arrayBuffer();
        await this.ctx.audioWorklet.addModule(this.assetUrl('hum_web_processor.js'));
        this.node = new AudioWorkletNode(this.ctx, 'hum-web-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit',
        });
        this.node.port.onmessage = e => this.handleMessage(e.data || {});
        this.node.onprocessorerror = () => this.onError('Browser audio processor failed');
        this.node.connect(this.ctx.destination);
        if (this.outputDeviceId) await this.setOutputDevice(this.outputDeviceId);
        await this.load(blob, tuning, inspection);
      } catch (error) {
        await this.disconnect();
        throw error;
      }
    }

    async load(blob, tuning, inspection) {
      if (!this.node) throw new Error('Browser audio is not connected');
      const header = HumWebHost.blobHeader(blob);
      if (header.sampleRate !== this.ctx.sampleRate)
        throw new Error(`Blob rate ${header.sampleRate} differs from browser rate ${this.ctx.sampleRate}`);
      this.ready = false;
      this.inputChannels = 0;
      this.stopFile();
      const id = ++this.loadSequence;
      const bridge = HumWebHost.bridgeFromInspection(inspection);
      const params = (tuning?.params || []).map(p => ({
        node_id: Number(p.node_id), param_id: Number(p.param_id), mutable: p.mutable,
      }));
      const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
      const message = { type: 'load', id, blob: blob.slice(0), params, bridge };
      // Instantiate WASM only once per AudioContext (can reload blobs cheaply).
      if (this.wasmBytes) { message.wasmBytes = this.wasmBytes; this.wasmBytes = null; }
      this.node.port.postMessage(message, [message.blob, ...(message.wasmBytes ? [message.wasmBytes] : [])]);
      const loadInfo = await promise;
      this.inputChannels = loadInfo.inputChannels;
      // Reload retains the AudioWorklet node and its live stream, but must
      // reject a new graph whose input shape no longer matches capture.
      if (this.liveStream) {
        try { this.validateLiveInput(this.liveStream); }
        catch (error) { this.stopLiveInput(); this.onError(error.message); }
      }
      this.ready = true;
      this.info = header;
      this.build = { blob, tuning };
      this.onLoaded(header);
    }

    handleMessage(msg) {
      if (msg.type === 'loaded' || msg.type === 'error') {
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (pending) {
            if (msg.type === 'loaded') pending.resolve(msg);
            else pending.reject(new Error(msg.error));
            return;
          }
        }
      }
      if (msg.type === 'error') this.onError(msg.error);
      else if (msg.type === 'lines') for (const line of (msg.lines || [])) this.onLine(line);
      else if (msg.type === 'info' && this.info) {
        const h = this.info;
        this.onLine(`OK HUM 0.1 blob_checksum=${h.checksum.toString(16).padStart(8,'0')} nodes=${h.nodes} params=${h.params} block=${h.block} sr=${h.sampleRate}`);
      }
    }

    command(cmd) {
      if (!this.node || !this.ready) throw new Error('Browser host not loaded');
      this.node.port.postMessage({ type: 'command', cmd });
    }

    async playFile(file, loop = true) {
      if (!this.ctx || !this.ready) throw new Error('Connect browser audio first');
      if (!this.inputChannels) throw new Error('This graph has no audio input; use an input pin or Source node');
      // A late file read/decode must not resurrect playback after Stop or a
      // switch to live input. Capture the generation before the first await.
      this.stopFile();
      this.stopLiveInput();
      const route = this.routeGeneration;
      if (!file) throw new Error('Choose an audio file first');
      const raw = await file.arrayBuffer();
      if (route !== this.routeGeneration || !this.ready || !this.ctx) return false;
      const buffer = await this.ctx.decodeAudioData(raw);
      if (route !== this.routeGeneration || !this.ready || !this.ctx) return false;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = !!loop;
      source.connect(this.node);
      source.onended = () => { if (this.source === source) this.source = null; };
      this.source = source;
      try {
        await this.ctx.resume();
        if (route !== this.routeGeneration || !this.ready || !this.ctx || !this.node) {
          source.disconnect();
          if (this.source === source) this.source = null;
          return false;
        }
        source.start();
      } catch (error) {
        source.disconnect();
        if (this.source === source) this.source = null;
        throw error;
      }
      return true;
    }

    validateLiveInput(stream) {
      if (!this.ctx || !this.node)
        throw new Error('Connect Browser (WASM) and load a graph before live input');
      if (!this.inputChannels)
        throw new Error('This graph has no audio input; use a graph input pin or Source node');
      if (this.inputChannels > 2)
        throw new Error('Live input supports at most two graph input channels');
      const tracks = stream?.getAudioTracks?.() || [];
      if (!tracks.length || tracks[0].readyState === 'ended')
        throw new Error('Live input stream has no active audio track');
      const channels = tracks[0].getSettings?.().channelCount;
      if (channels != null && channels !== 1 && channels !== 2)
        throw new Error(`Unsupported live capture channel count: ${channels}`);
      // 1->2 duplicate and 2->1 first-channel mapping are explicit host adapters.
    }

    async playLiveInput(stream) {
      if (!this.ready || !this.ctx || !this.node)
        throw new Error('Connect Browser (WASM) and load a graph before live input');
      this.validateLiveInput(stream);
      // An older resume must not reconnect audio after Stop or a newer Start.
      const route = ++this.routeGeneration;
      // Create before replacing the existing source, so failed capture does
      // not interrupt a working file/live stream.
      const source = this.ctx.createMediaStreamSource(stream);
      const adapters = [];
      let analyser = null;
      try {
        await this.ctx.resume();
        if (route !== this.routeGeneration || !this.ready || !this.ctx || !this.node) {
          source.disconnect();
          return false;
        }
        if (this.ctx.state !== 'running') throw new Error('Browser audio is suspended');
        this.stopFile();
        this.stopLiveInput();
        // Insert an analyser IN SERIES with the existing route. No dry bypass
        // and no additional audio output; it only provides a diagnostic tap.
        const routeSource = typeof this.ctx.createAnalyser === 'function'
          ? (analyser = this.ctx.createAnalyser()) : source;
        if (analyser) {
          analyser.fftSize = 2048;
          source.connect(analyser);
        }
        const channels = stream.getAudioTracks()[0].getSettings?.().channelCount;
        if (channels && channels !== this.inputChannels) {
          const splitter = this.ctx.createChannelSplitter(channels);
          const merger = this.ctx.createChannelMerger(this.inputChannels);
          routeSource.connect(splitter);
          for (let c = 0; c < this.inputChannels; c++)
            splitter.connect(merger, channels === 1 ? 0 : c, c);
          merger.connect(this.node);
          adapters.push(splitter, merger);
          this.onLine(`Live channel mapping: ${channels} input(s) -> ${this.inputChannels} Hum input(s) (${channels === 2 ? 'first channel used for mono' : 'mono duplicated for stereo'})`);
        } else { routeSource.connect(this.node); }
        this.liveAnalyser = analyser;
        this.liveMeterBuffer = analyser ? new Float32Array(analyser.fftSize) : null;
        this.liveAdapter = adapters;
        this.liveSource = source;
        this.liveStream = stream;
        return true;
      } catch (error) {
        try { source.disconnect(); } catch (_) {}
        if (analyser) try { analyser.disconnect(); } catch (_) {}
        for (const adapter of adapters) try { adapter.disconnect(); } catch (_) {}
        throw error;
      }
    }

    liveInputLevel() {
      if (!this.liveStream || !this.liveAnalyser || !this.liveMeterBuffer) return null;
      this.liveAnalyser.getFloatTimeDomainData(this.liveMeterBuffer);
      let peak = 0, sum = 0;
      for (const sample of this.liveMeterBuffer) {
        const x = Math.abs(sample);
        if (x > peak) peak = x;
        sum += sample * sample;
      }
      return { peak, rms: Math.sqrt(sum / this.liveMeterBuffer.length),
        peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
        clipping: peak >= 0.999 };
    }

    diagnostics() {
      return { audioContextRate: this.ctx?.sampleRate ?? null,
        audioContextState: this.ctx?.state ?? 'closed',
        graphRate: this.info?.sampleRate ?? null,
        graphInputChannels: this.inputChannels,
        outputDeviceId: this.outputDeviceId,
        outputMethod: this.outputElement ? 'media-element' :
          typeof this.ctx?.setSinkId === 'function' ? 'audio-context' : 'system-default',
        liveRouted: !!this.liveStream };
    }

    stopLiveInput() {
      ++this.routeGeneration;
      if (this.liveSource) {
        try { this.liveSource.disconnect(); } catch (_) {}
      }
      if (this.liveAnalyser) try { this.liveAnalyser.disconnect(); } catch (_) {}
      this.liveAnalyser = null;
      this.liveMeterBuffer = null;
      for (const adapter of this.liveAdapter) try { adapter.disconnect(); } catch (_) {}
      this.liveAdapter = [];
      this.liveSource = null;
      this.liveStream = null;
      // Capture tracks are owned/released by HumAudioInput, not the host.
    }

    async setOutputDevice(deviceId = '') {
      if (!this.ctx) { this.outputDeviceId = deviceId; return; }
      if (typeof this.ctx.setSinkId === 'function') {
        await this.ctx.setSinkId(deviceId || '');
        this.outputDeviceId = deviceId;
        return;
      }
      // Some browsers expose sink selection on HTMLMediaElement but not
      // AudioContext. Route the same worklet output to a MediaStreamDestination.
      if (!deviceId) {
        if (this.outputStreamDestination) {
          this.node.disconnect();
          this.node.connect(this.ctx.destination);
          this.releaseOutputElement();
        }
        this.outputDeviceId = '';
        return;
      }
      const audio = window.document?.createElement('audio');
      if (!audio || typeof audio.setSinkId !== 'function')
        throw new Error('This browser cannot select a playback device. Use Chrome/Edge, enable output selection in your browser, or use the system default output.');
      const destination = this.ctx.createMediaStreamDestination();
      audio.autoplay = true;
      audio.srcObject = destination.stream;
      try {
        await audio.setSinkId(deviceId);
        this.node.disconnect();
        this.node.connect(destination);
        await audio.play();
        this.releaseOutputElement();
        this.outputElement = audio;
        this.outputStreamDestination = destination;
        this.outputDeviceId = deviceId;
      } catch (error) {
        audio.pause();
        audio.srcObject = null;
        this.node.disconnect();
        this.node.connect(this.outputStreamDestination || this.ctx.destination);
        throw error;
      }
    }

    releaseOutputElement() {
      if (this.outputElement) {
        try { this.outputElement.pause(); this.outputElement.srcObject = null; } catch (_) {}
      }
      this.outputElement = null;
      this.outputStreamDestination = null;
    }

    stopFile() {
      ++this.routeGeneration;
      if (!this.source) return;
      try { this.source.stop(); } catch (_) {}
      this.source.disconnect();
      this.source = null;
    }

    async disconnect() {
      this.stopFile();
      this.stopLiveInput();
      this.releaseOutputElement();
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error('Browser host closed'));
      this.pending.clear();
      if (this.node) { try { this.node.disconnect(); this.node.port.close(); } catch (_) {} }
      this.node = null;
      if (this.ctx) { try { await this.ctx.close(); } catch (_) {} }
      this.ctx = null;
      this.info = null;
      this.inputChannels = 0;
    }
  }
  window.HumWebHost = HumWebHost;
})();
