// A user gesture unlocks this context once. New verses replace buffer sources,
// never the context, so timer-driven playback keeps the same audio permission.
// Some browsers play a recording in an <audio> element but cannot download it
// for Web Audio or decode it there. If that happens before Web Audio has
// played anything, the session plays every verse through one built-in audio
// element instead.
const safeDetail = value => String(value || '').replace(/https?:\/\/[^\s]+/gi, '[URL]').replace(/[\r\n\t]+/g, ' ').slice(0, 160);

export function describeAudioFailure(failure) {
  if (!failure) return 'Audio could not play. Tap the speaker to retry.';
  const labels = { enable: 'Audio could not start', download: 'Audio download failed', read: 'Audio download could not be read', decode: 'Audio decoding failed', start: 'Audio playback failed' };
  const details = [safeDetail(failure.name)];
  if (failure.message && failure.message !== failure.name) details.push(safeDetail(failure.message));
  if (failure.status !== undefined) details.push(`HTTP ${failure.status}`);
  if (failure.type) details.push(safeDetail(failure.type));
  if (failure.bytes !== undefined) details.push(`${failure.bytes} bytes`);
  if (failure.contextState) details.push(`context ${failure.contextState}`);
  if (failure.element) details.push(`built-in player${failure.reason ? ` after Web Audio ${safeDetail(failure.reason)}` : ''}`);
  return `${labels[failure.stage] || 'Audio could not play'} (${details.filter(Boolean).join('; ')}). Tap the speaker to retry.`;
}

export class VerseAudioSession extends EventTarget {
  constructor({
    Context = globalThis.AudioContext || globalThis.webkitAudioContext,
    fetchAudio = globalThis.fetch.bind(globalThis),
    createElement = globalThis.Audio ? () => new globalThis.Audio() : null,
  } = {}) {
    super();
    this.Context = Context;
    this.fetchAudio = fetchAudio;
    this.createElement = createElement;
    this.element = null;
    this.elementSrc = '';
    this.useElement = false;
    this.fallbackReason = '';
    this.decodedOnce = false;
    this.context = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    this.request = null;
    this.pending = null;
    this.unlocking = null;
    this.unlockError = null;
    this.unlockAttempt = 0;
    this.version = 0;
    this.offset = 0;
    this.startedAt = 0;
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.failure = null;
    this._src = '';
    this._muted = false;
  }
  get src() { return this._src; }
  set src(value) {
    this.load();
    this._src = String(value);
  }
  get currentSrc() { return this._src; }
  get duration() {
    if (this.useElement) return this.elementSrc === this._src ? this.element.duration : NaN;
    return this.buffer?.duration ?? NaN;
  }
  get currentTime() {
    if (this.useElement) return this.elementSrc === this._src ? this.element.currentTime : 0;
    return this.source && !this.paused
      ? Math.min(this.buffer.duration, this.offset + this.context.currentTime - this.startedAt)
      : this.offset;
  }
  get muted() { return this._muted; }
  set muted(value) {
    this._muted = Boolean(value);
    if (this.gain) this.gain.gain.value = this._muted ? 0 : 1;
    if (this.element) this.element.muted = this._muted;
  }
  // Call directly within a real click handler, before awaiting any audio fetch.
  unlock() {
    const attempt = ++this.unlockAttempt;
    this.unlockError = null;
    try {
      // Keep context creation and resume synchronous inside the trusted gesture.
      return this.unlockContext().catch(error => {
        if (attempt === this.unlockAttempt) this.unlockError = error;
        throw error;
      });
    } catch (error) {
      this.unlockError = error;
      return Promise.reject(error);
    }
  }
  unlockContext() {
    if (!this.context) {
      if (!this.Context) return Promise.reject(new Error('Web Audio is unavailable'));
      this.context = new this.Context();
      this.gain = this.context.createGain();
      this.gain.gain.value = this._muted ? 0 : 1;
      this.gain.connect(this.context.destination);
      this.context.addEventListener('statechange', () => {
        if (this.context.state !== 'running' && this.source) {
          this.pause();
          this.dispatchEvent(new Event('interrupted'));
        }
      });
    }
    if (this.context.state === 'running') return Promise.resolve();
    // resume() must run now, in the gesture, even if an earlier resume is pending.
    const resumed = this.context.resume();
    let timeout;
    const attempt = Promise.race([
      resumed,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new DOMException('Tap the speaker to resume audio', 'NotAllowedError')), 2000); }),
    ]).then(() => {
      if (this.context.state !== 'running') throw new DOMException('Audio is suspended', 'NotAllowedError');
    }).finally(() => {
      clearTimeout(timeout);
      if (this.unlocking === attempt) this.unlocking = null;
    });
    this.unlocking = attempt;
    return attempt;
  }
  pause() {
    this.offset = this.currentTime;
    this.version++;
    this.request?.abort();
    this.request = null;
    this.pending = null;
    if (this.source) {
      // stop() can emit ended; it is never natural verse completion.
      const previous = this.source;
      this.source = null;
      previous.onended = null;
      previous.stop();
      previous.disconnect();
    }
    // Mark the pause first so the element's own pause event is not taken
    // for an interruption.
    this.paused = true;
    this.element?.pause();
  }
  load() {
    this.pause();
    this.buffer = null;
    this.offset = 0;
    this.ended = false;
    this.error = null;
    this.failure = null;
    if (this.elementSrc) {
      // Stop downloading the previous verse.
      this.elementSrc = '';
      this.element.removeAttribute('src');
      this.element.load();
    }
  }
  removeAttribute(name) {
    if (name === 'src') { this.load(); this._src = ''; }
  }
  play() {
    if (!this.paused && (this.source || this.useElement)) return Promise.resolve();
    if (this.pending) return this.pending;
    const version = this.version;
    const url = this._src;
    const current = () => version === this.version && url === this._src;
    const aborted = () => new DOMException('Verse changed', 'AbortError');
    // Keep metadata local so a late failure from an old verse cannot replace it.
    const failure = { stage: 'enable' };
    this.failure = null;
    const task = (async () => {
      if (this.unlocking) await this.unlocking;
      if (!current()) throw aborted();
      if (this.unlockError) throw this.unlockError;
      if (!this.context || this.context.state !== 'running') {
        throw new DOMException('Tap the speaker to enable audio', 'NotAllowedError');
      }
      if (!url) throw new Error('No verse recording selected');
      if (this.useElement) return this.playElement(url, current, failure);
      if (!this.buffer) {
        let decoded;
        try {
          failure.stage = 'download';
          const request = new AbortController();
          this.request = request;
          const response = await this.fetchAudio(url, { signal: request.signal });
          failure.status = response.status;
          failure.type = safeDetail(response.headers?.get('content-type'));
          if (!response.ok) throw new Error('The server did not return the verse recording');
          failure.stage = 'read';
          const bytes = await response.arrayBuffer();
          failure.bytes = bytes.byteLength;
          if (!current()) throw aborted();
          failure.stage = 'decode';
          decoded = await this.context.decodeAudioData(bytes);
        } catch (error) {
          if (!current()) throw aborted();
          // The built-in player needs neither CORS nor Web Audio decoding, so
          // it can play a recording this browser could not download (TypeError:
          // blocked or failed request) or decode itself. Once Web Audio has
          // played a recording, a failure means a bad file or network, which
          // is reported as before.
          const elementMayWork = failure.stage === 'decode' || error?.name === 'TypeError';
          if (!this.createElement || this.decodedOnce || error?.name === 'AbortError' || !elementMayWork) throw error;
          this.request = null;
          this.useElement = true;
          this.fallbackReason = `${error?.name || 'Error'} on ${failure.stage}`;
          return this.playElement(url, current, failure);
        }
        if (!current()) throw aborted();
        this.decodedOnce = true;
        this.buffer = decoded; // Only the current verse is retained in memory.
        this.request = null;
      }
      if (!current()) throw aborted();
      failure.stage = 'start';
      if (this.context.state !== 'running') throw new DOMException('Audio is suspended', 'NotAllowedError');
      if (this.offset >= this.buffer.duration) this.offset = 0;
      const source = this.context.createBufferSource();
      source.buffer = this.buffer;
      source.onended = () => {
        if (!current() || this.source !== source || this.paused) return;
        source.onended = null;
        source.disconnect();
        this.source = null;
        this.offset = this.buffer.duration;
        this.paused = true;
        this.ended = true;
        this.dispatchEvent(new Event('ended'));
      };
      try {
        source.connect(this.gain);
        source.start(0, this.offset);
      } catch (error) {
        // An unstarted source cannot be stopped on retry; release it now.
        source.onended = null;
        try { source.disconnect(); } catch {}
        throw error;
      }
      this.source = source;
      this.startedAt = this.context.currentTime;
      this.paused = false;
      this.ended = false;
      this.error = null;
      this.failure = null;
    })().catch(error => {
      if (current() && error.name !== 'AbortError') {
        this.failure = { ...failure, name: safeDetail(error.name), message: safeDetail(error.message), contextState: this.context?.state || 'unavailable' };
        if (error.name !== 'NotAllowedError') this.error = error;
      }
      throw error;
    }).finally(() => {
      if (this.pending === task) this.pending = null;
    });
    this.pending = task;
    return task;
  }
  async playElement(url, current, failure) {
    // The element downloads the file itself; Web Audio's download details do not apply.
    delete failure.status;
    delete failure.type;
    delete failure.bytes;
    failure.stage = 'start';
    failure.element = true;
    failure.reason = this.fallbackReason;
    const element = this.element || this.makeElement();
    if (this.elementSrc !== url || element.error) {
      element.src = url;
      this.elementSrc = url;
    } else if (element.ended) {
      element.currentTime = 0;
    }
    element.muted = this._muted;
    // A media error after the file's header has loaded does not reject a
    // pending play(), so listen for it too.
    const playing = element.play();
    playing.catch(() => {});
    let onError;
    try {
      await Promise.race([playing, new Promise((_, reject) => {
        onError = () => reject(new DOMException(safeDetail(element.error?.message || `code ${element.error?.code}`), 'MediaError'));
        element.addEventListener('error', onError);
      })]);
    } catch (error) {
      // Something outside the page paused the element before it started.
      if (error?.name === 'AbortError' && current()) throw new DOMException('Playback was paused', 'NotAllowedError');
      throw error;
    } finally {
      element.removeEventListener('error', onError);
    }
    if (!current()) throw new DOMException('Verse changed', 'AbortError');
    this.paused = false;
    this.ended = false;
    this.error = null;
    this.failure = null;
  }
  makeElement() {
    const element = this.element = this.createElement();
    element.preload = 'auto';
    element.addEventListener('ended', () => {
      if (this.paused || this.elementSrc !== this._src) return;
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event('ended'));
    });
    element.addEventListener('playing', () => {
      // A resume the session did not ask for (media notification, headset
      // button, the system after a short audio-focus loss).
      if (!this.paused || this.pending || this.elementSrc !== this._src) return;
      this.paused = false;
      this.ended = false;
      this.dispatchEvent(new Event('resumed'));
    });
    element.addEventListener('pause', () => {
      // A pause the session did not ask for (another app took the audio, a
      // headset was unplugged) needs a tap to resume, like a suspended context.
      if (this.paused || element.ended) return;
      this.paused = true;
      this.dispatchEvent(new Event('interrupted'));
    });
    element.addEventListener('error', () => {
      if (this.paused || !element.error) return;
      this.paused = true;
      this.error = element.error;
      this.failure = {
        stage: 'start', element: true, name: 'MediaError',
        message: safeDetail(element.error.message || `code ${element.error.code}`),
        contextState: this.context?.state || 'unavailable',
      };
      this.dispatchEvent(new Event('error'));
    });
    return element;
  }
}
