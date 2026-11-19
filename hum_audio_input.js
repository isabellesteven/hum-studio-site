/* Hum Studio 4.2 / Steps 1–2: browser recording-device discovery and stream ownership.
 * Owns capture tracks; HumWebHost owns Web Audio graph routing. */
'use strict';
(function (global) {
  class HumAudioInput {
    constructor({ mediaDevices, onChange = () => {} } = {}) {
      this.mediaDevices = mediaDevices ?? global.navigator?.mediaDevices;
      this.onChange = onChange;
      this.devices = [];
      this.stream = null;
      this.deviceId = '';
      this.error = '';
      this.busy = false;
      this._generation = 0;
      this._destroyed = false;
      this._refreshGeneration = 0;
      this._deviceChange = () => { void this.refresh().catch(() => {}); };
      if (this.mediaDevices?.addEventListener)
        this.mediaDevices.addEventListener('devicechange', this._deviceChange);
    }

    get supported() {
      return !!(this.mediaDevices?.getUserMedia && this.mediaDevices?.enumerateDevices);
    }

    get active() { return !!this.stream?.getAudioTracks().some(t => t.readyState === 'live'); }

    notify() {
      this.onChange({ devices: this.devices.slice(), active: this.active, busy: this.busy,
        error: this.error, settings: this.settings() });
    }

    settings() {
      const track = this.stream?.getAudioTracks()[0];
      if (!track) return null;
      const s = typeof track.getSettings === 'function' ? track.getSettings() : {};
      return { deviceId: s.deviceId || '', sampleRate: s.sampleRate ?? null,
        channelCount: s.channelCount ?? null,
        echoCancellation: s.echoCancellation ?? null,
        noiseSuppression: s.noiseSuppression ?? null,
        autoGainControl: s.autoGainControl ?? null };
    }

    async refresh() {
      if (!this.supported || this._destroyed) {
        this.devices = [];
        this.notify();
        return [];
      }
      const refreshGeneration = ++this._refreshGeneration;
      try {
        const list = await this.mediaDevices.enumerateDevices();
        if (this._destroyed || refreshGeneration !== this._refreshGeneration) return [];
        this.devices = list.filter(d => d.kind === 'audioinput').map((d, i) => ({
          deviceId: d.deviceId, label: d.label || `Audio input ${i + 1}`,
        }));
        // Some devices vanish without firing a MediaStreamTrack ended event.
        // Only a confirmed selected physical device disappearance stops capture.
        const actual = this.settings()?.deviceId;
        if (this.active && actual && actual !== 'default' &&
            !this.devices.some(d => d.deviceId === actual)) {
          this._stopTracks();
          ++this._generation;
          this.error = 'Selected audio input device was disconnected';
        }
        this.notify();
        return this.devices;
      } catch (e) {
        if (refreshGeneration !== this._refreshGeneration || this._destroyed) return [];
        this.error = `Cannot enumerate input devices: ${e.message || e.name}`;
        this.notify();
        return [];
      }
    }

    async start(deviceId = '', channels = null) {
      if (!this.supported) throw new Error('Recording devices require localhost/HTTPS and a browser with getUserMedia support');
      const generation = ++this._generation;
      this._stopTracks();
      this.error = '';
      this.busy = true;
      this.deviceId = deviceId;
      this.notify();
      try {
        const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (deviceId) audio.deviceId = { exact: deviceId }; // Never silently substitute another microphone.
        if (channels === 1 || channels === 2) audio.channelCount = { ideal: channels };
        const stream = await this.mediaDevices.getUserMedia({ audio, video: false });
        if (this._destroyed || generation !== this._generation) {
          stream.getTracks().forEach(t => t.stop());
          return false;
        }
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach(t => t.stop());
          throw new Error('Browser returned a stream without an audio track');
        }
        const actualId = stream.getAudioTracks()[0].getSettings?.().deviceId;
        if (deviceId && actualId && actualId !== deviceId) {
          stream.getTracks().forEach(t => t.stop());
          throw new Error('Browser opened a different input device from the one selected');
        }
        this.stream = stream;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener?.('ended', () => {
            if (this.stream === stream) { this._stopTracks(); this.error = 'Input device stopped or was disconnected'; this.notify(); }
          });
        }
        await this.refresh();  // Device labels often become available after permission.
        return generation === this._generation && !this._destroyed && this.active;
      } catch (e) {
        if (generation === this._generation && !this._destroyed) {
          this.error = e?.name === 'NotAllowedError' ? 'Microphone permission was denied' :
            e?.name === 'NotFoundError' ? 'No matching audio input device was found' :
            e?.name === 'NotReadableError' ? 'Audio input is unavailable or in use' :
            e?.name === 'OverconstrainedError' ? 'Selected recording device or channel configuration is unavailable' :
            `Audio capture failed: ${e.message || e.name}`;
        }
        if (generation === this._generation) throw e;
        return false;
      } finally {
        if (generation === this._generation && !this._destroyed) { this.busy = false; this.notify(); }
      }
    }

    _stopTracks() {
      if (this.stream) {
        const stream = this.stream;
        this.stream = null;
        stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      }
    }

    stop() {
      ++this._generation; // Cancel any late permission response.
      this._stopTracks();
      this.busy = false;
      this.error = '';
      this.notify();
    }

    destroy() {
      ++this._refreshGeneration;
      this.stop();
      this._destroyed = true;
      this.mediaDevices?.removeEventListener?.('devicechange', this._deviceChange);
    }
  }
  global.HumAudioInput = HumAudioInput;
})(typeof window !== 'undefined' ? window : globalThis);
