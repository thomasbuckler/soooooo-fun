import { AUTO_ADVANCE_DELAY_MS } from './player.mjs?v=continuous-dial-7';

// One revolution spans the reading and its scheduled pause. Keep the angle
// unwrapped at automatic transitions so crossing twelve never stops the hand.
export function createAudioDial({ audio, draw, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, now = () => performance.now() }) {
  let state = { key: null, auto: false };
  let angle = 0;
  let target = 360;
  let speed = 30;
  let playing = null;
  let waiting = null;
  let loading = null;
  let frame = null;
  const nextTurn = value => (Math.floor(value / 360 + 1e-8) + 1) * 360;

  function stopFrame() {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  }
  function tick() {
    frame = null;
    const time = now();
    let moving = false;
    if (!state.auto || !state.key) {
      angle = 0;
    } else if (state.active) {
      if (state.phase === 'playing' && !audio.paused && Number.isFinite(audio.duration)) {
        if (!playing) {
          target = nextTurn(angle);
          speed = (target - angle) / (Math.max(0, audio.duration - audio.currentTime) + AUTO_ADVANCE_DELAY_MS / 1000);
          playing = { from: angle, position: audio.currentTime, duration: audio.duration, speed };
          waiting = loading = null;
        }
        angle = playing.from + Math.max(0, audio.currentTime - playing.position) * playing.speed;
        moving = true;
      } else if (state.phase === 'waiting' && Number.isFinite(state.advanceAt)) {
        if (!waiting || waiting.deadline !== state.advanceAt) {
          if (playing) {
            angle = playing.from + (playing.duration - playing.position) * playing.speed;
            playing = null;
          }
          speed = (target - angle) / Math.max(0.001, (state.advanceAt - time) / 1000);
          waiting = { from: angle, time, deadline: state.advanceAt, speed };
          loading = null;
        }
        angle = waiting.from + Math.max(0, time - waiting.time) / 1000 * waiting.speed;
        moving = true;
      } else if (state.phase === 'ended' && waiting) {
        angle = waiting.from + Math.max(0, time - waiting.time) / 1000 * waiting.speed;
        moving = true;
      } else if (state.phase === 'loading' && !playing) {
        // Keep moving while the newly displayed verse's recording loads.
        if (!loading) loading = { from: angle, time };
        angle = loading.from + Math.max(0, time - loading.time) / 1000 * speed;
        moving = true;
      }
    }
    draw(angle);
    if (moving) frame = requestFrame(tick);
  }
  function update(next) {
    stopFrame();
    if (!next.auto || !state.auto || !next.key) {
      angle = 0;
      target = 360;
      playing = waiting = loading = null;
    } else if (next.key !== state.key) {
      // Automatic next-verse changes retain the completed turn; manual skips
      // during a reading start a fresh turn for the newly selected verse.
      if (!waiting) angle = 0;
      target = nextTurn(angle);
      playing = waiting = loading = null;
    } else if (!state.active && next.active) {
      // Resume a canceled/restarted pause from the hand's frozen position.
      waiting = loading = null;
    }
    state = next;
    tick();
  }
  return { update, destroy: stopFrame };
}
