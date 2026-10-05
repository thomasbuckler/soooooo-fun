// One reusable audio session; only natural completion starts auto-advance.
export const AUTO_ADVANCE_DELAY_MS = 2000;
export function verseKey(reference) {
  const match = String(reference).trim().match(/^(.+?)\s+(\d+):(\d+)$/);
  if (!match) return null;
  return `${match[1].toLowerCase().replace(/[\s-]+/g, '-')}:${Number(match[2])}:${Number(match[3])}`;
}

export function createVersePlayer({
  audio, tracks, baseURL, onState = () => {}, onAdvance = () => {},
  muted = false, setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now(),
}) {
  let key = null;
  let active = true;
  let auto = false;
  let phase = 'idle';
  let timer = null;
  let advanceAt = null;
  let revision = 0;
  let finished = false;
  let removeListeners = () => {};
  audio.preload = 'none';
  audio.muted = muted;

  const snapshot = () => ({ key, active, muted: audio.muted, auto, phase, advanceAt });
  const publish = () => onState(snapshot());
  const interrupted = () => {
    if (!active || !key) return;
    cancelAdvance();
    phase = 'blocked';
    publish();
  };
  audio.addEventListener('interrupted', interrupted);
  // The built-in player can be resumed from outside the page (media
  // notification, headset button).
  const resumed = () => {
    if (!active || !key || finished) return;
    phase = 'playing';
    publish();
  };
  audio.addEventListener('resumed', resumed);
  function cancelAdvance() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    advanceAt = null;
    if (phase === 'waiting') phase = 'ended';
  }
  function scheduleAdvance() {
    cancelAdvance();
    if (!auto || !active || !finished || !key) return;
    const expected = revision;
    advanceAt = now() + AUTO_ADVANCE_DELAY_MS;
    phase = 'waiting';
    timer = setTimer(() => {
      timer = null;
      advanceAt = null;
      if (expected !== revision || !auto || !active || !finished) return;
      // The adapter follows the app's current shuffled order, never verse + 1.
      finished = false;
      phase = 'ended';
      publish();
      onAdvance(key);
    }, AUTO_ADVANCE_DELAY_MS);
  }
  function play() {
    if (!key || !tracks[key] || !active || finished) return;
    const expected = revision;
    if (audio.error) audio.load();
    phase = 'loading';
    publish();
    try {
      Promise.resolve(audio.play()).then(() => {
        if (expected !== revision || !active || finished) return;
        phase = 'playing';
        publish();
      }).catch(error => {
        if (expected !== revision || !active || error?.name === 'AbortError') return;
        phase = error?.name === 'NotAllowedError' ? 'blocked' : 'error';
        cancelAdvance();
        publish();
      });
    } catch (error) {
      phase = error?.name === 'NotAllowedError' ? 'blocked' : 'error';
      publish();
    }
  }
  function setVerse(next) {
    if (next === key) return;
    revision++;
    cancelAdvance();
    removeListeners();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    key = next;
    finished = false;
    phase = !key ? 'idle' : tracks[key] ? 'loading' : 'missing';
    if (!key || !tracks[key]) { publish(); return; }
    const expected = revision;
    const url = new URL(tracks[key], baseURL).href;
    const ended = () => {
      if (expected !== revision || !active || finished || !audio.ended || audio.currentSrc !== url) return;
      finished = true;
      phase = 'ended';
      scheduleAdvance();
      publish();
    };
    const failed = () => {
      if (expected !== revision || !audio.error) return;
      finished = false;
      cancelAdvance();
      phase = 'error';
      publish();
    };
    audio.addEventListener('ended', ended);
    audio.addEventListener('error', failed);
    removeListeners = () => {
      audio.removeEventListener('ended', ended);
      audio.removeEventListener('error', failed);
    };
    audio.src = url;
    if (active) play();
    else { phase = 'paused'; publish(); }
  }
  function setActive(value) {
    if (active === value) return;
    active = value;
    if (!active) {
      cancelAdvance();
      audio.pause();
      if (key && tracks[key]) phase = 'paused';
    } else if (finished) {
      phase = 'ended';
      scheduleAdvance();
    } else play();
    publish();
  }
  function setMuted(value) {
    audio.muted = Boolean(value);
    // Muting keeps the real playback clock, so auto-advance still works.
    if (!audio.muted && (phase === 'blocked' || phase === 'error')) play();
    publish();
  }
  function setAuto(value) {
    auto = Boolean(value);
    if (auto) scheduleAdvance();
    else cancelAdvance();
    publish();
  }
  function retry() {
    if (phase === 'blocked' || phase === 'error') play();
  }
  function destroy() {
    revision++;
    cancelAdvance();
    removeListeners();
    audio.removeEventListener('interrupted', interrupted);
    audio.removeEventListener('resumed', resumed);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  return { setVerse, setActive, setMuted, setAuto, retry, snapshot, destroy };
}
