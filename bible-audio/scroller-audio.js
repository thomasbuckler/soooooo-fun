// Drop-in integration for the existing Holy Scroller at soooooo.fun.
// Include once in the document shell, after hydration scripts, as type="module".
import { createVersePlayer, verseKey } from './player.mjs?v=continuous-dial-7';
import { VerseAudioSession, describeAudioFailure } from './audio-session.mjs?v=audio-fallback-11';
import { createAudioDial } from './audio-dial.mjs?v=continuous-dial-7';

const marker = Symbol.for('holy-scroller.audio.v1');
if (!window[marker]) {
  window[marker] = true;
  start().catch(error => {
    console.error('Holy Scroller audio could not load:', error);
    document.querySelectorAll('[data-bible-audio-control]').forEach(button => {
      button.disabled = true;
      button.title = 'Audio could not load. Refresh to retry.';
    });
    const status = document.querySelector('#bible-audio-status');
    if (status) status.textContent = 'Audio could not load. Refresh to retry.';
  });
}

async function start() {
  // Wait for the existing app to hydrate before adding anything to its DOM.
  await new Promise(resolve => {
    const ready = () => [...document.querySelectorAll('button[aria-label="Choose book and chapter"]')].some(button => !button.disabled);
    if (ready()) { resolve(); return; }
    const hydration = new MutationObserver(() => {
      if (ready()) { hydration.disconnect(); resolve(); }
    });
    hydration.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  });
  const root = new URL('./', import.meta.url);
  const audioRoot = new URL(document.querySelector('meta[name="bible-audio-base"]')?.content || '../', root);
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('scroller-audio.css?v=home-7', root).href;
  document.head.append(style);

  const status = document.createElement('p');
  status.id = 'bible-audio-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  document.body.append(status);
  const audio = new VerseAudioSession();

  let player;
  let state = { muted: false, auto: false, phase: 'loading' };
  try { state.muted = localStorage.getItem('holy-scroller-audio-muted') === 'true'; } catch {}
  let frame = 0;
  let lastKey = null;
  const controls = new Set();
  const dial = createAudioDial({
    audio,
    draw(angle) {
      for (const group of controls) {
        group.querySelector('[data-audio-clock-hand]')?.setAttribute('transform', `rotate(${angle} 12 12)`);
      }
    },
  });
  function activateAudio() {
    // Unlock synchronously during the tap, before any asynchronous verse work.
    try {
      audio.unlock().then(() => player?.retry()).catch(() => player?.retry());
    } catch {
      player?.retry();
    }
  }
  const icon = paths => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  // Match the book and heart's visible vertical bounds: y=3 through y=21.
  const speaker = '<path d="M11 3 5 8H2v8h3l6 5V3Z"/>';
  const soundOn = icon(`${speaker}<path d="M15 7c4 3 4 7 0 10M18 3c6 5 6 13 0 18"/>`);
  const soundOff = icon(`${speaker}<path d="m17 9 5 6m0-6-5 6"/>`);
  const clock = icon('<circle cx="12" cy="12" r="9"/><path data-audio-clock-hand d="M12 12V5"/>');
  const visible = element => Boolean(element?.isConnected && !element.closest('[aria-hidden="true"],.hidden') && element.getClientRects().length);
  function currentVerse() {
    const body = [...document.querySelectorAll('.verse-body')].find(visible);
    if (!body) return null;
    return verseKey(body.previousElementSibling?.textContent || '');
  }
  function announce(text) {
    if (status.textContent !== text) status.textContent = text;
  }
  function paint() {
    for (const group of controls) {
      if (!group.isConnected) { controls.delete(group); continue; }
      const [timer, sound] = group.children;
      const blocked = state.phase === 'blocked';
      const soundLabel = state.phase === 'error' ? 'Retry verse audio' : blocked ? 'Enable verse audio' : state.muted ? 'Unmute verse audio' : 'Mute verse audio';
      if (sound.getAttribute('aria-label') !== soundLabel) {
        sound.setAttribute('aria-label', soundLabel);
        sound.title = soundLabel;
      }
      const soundState = state.muted || blocked ? 'off' : 'on';
      if (sound.dataset.state !== soundState) {
        sound.dataset.state = soundState;
        sound.innerHTML = soundState === 'on' ? soundOn : soundOff;
        sound.setAttribute('aria-pressed', String(soundState === 'on'));
      }
      if (timer.getAttribute('aria-pressed') !== String(state.auto)) {
        timer.setAttribute('aria-pressed', String(state.auto));
        timer.title = state.auto ? 'Turn off auto-scroll' : 'Auto-scroll 2 seconds after each verse finishes';
        timer.setAttribute('aria-label', timer.title);
      }
      if (sound.disabled !== !player) sound.disabled = !player;
      if (timer.disabled !== !player) timer.disabled = !player;
    }
    dial.update(state);
    if (!lastKey) announce('');
    else if (state.phase === 'blocked') announce('Tap the speaker to enable audio.');
    else if (state.phase === 'error') announce(describeAudioFailure(audio.failure));
    else if (state.phase === 'missing') announce('No recording for this verse.');
    else announce('');
  }
  // One menu button replaces each header's icon row. Its drop-down shows the
  // row's own buttons (Home, book and chapter, Favorites) followed by the
  // audio clock and speaker.
  const menuIcon = icon('<path d="M4 6h16M4 12h16M4 18h16"/>');
  let menu = null;
  const besides = new Set();
  let swallowClickUntil = 0;
  function closeMenu() {
    if (!menu) return;
    menu.panel.remove();
    menu.toggle.setAttribute('aria-expanded', 'false');
    menu = null;
    paint();
  }
  function openMenu(toggle, row) {
    closeMenu();
    const panel = document.createElement('div');
    panel.dataset.bibleMenu = '';
    panel.setAttribute('aria-label', 'Menu');
    for (const original of row.querySelectorAll(':scope > button')) {
      const item = document.createElement('button');
      item.type = 'button';
      item.dataset.bibleMenuItem = '';
      item.setAttribute('aria-label', original.getAttribute('aria-label') || '');
      item.title = original.title || original.getAttribute('aria-label') || '';
      item.disabled = original.disabled;
      item.innerHTML = original.querySelector('svg')?.outerHTML || '';
      item.addEventListener('click', () => { closeMenu(); original.click(); });
      if (!original.hasAttribute('data-bible-beside')) panel.append(item);
    }
    const group = makeAudioControls();
    panel.append(group);
    controls.add(group);
    const box = toggle.getBoundingClientRect();
    panel.style.top = `${box.bottom}px`;
    panel.style.right = `${document.documentElement.clientWidth - box.right}px`;
    document.body.append(panel);
    toggle.setAttribute('aria-expanded', 'true');
    menu = { panel, toggle };
    paint();
  }
  // A tap outside the open menu only closes it; it does not also save a
  // verse or press whatever is underneath.
  document.addEventListener('pointerdown', event => {
    if (!menu || menu.panel.contains(event.target) || menu.toggle.contains(event.target)) return;
    closeMenu();
    swallowClickUntil = performance.now() + 600;
  }, { capture: true });
  document.addEventListener('click', event => {
    if (performance.now() > swallowClickUntil) return;
    swallowClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
  function mountControls() {
    if (menu && !visible(menu.toggle)) closeMenu();
    for (const header of document.querySelectorAll('header')) {
      if (!visible(header) || header.querySelector('[data-bible-menu-toggle]')) continue;
      // The existing top-right Home/book/Favorites row in every view.
      const bookButton = header.querySelector('button[aria-label="Choose book and chapter"]');
      const row = bookButton?.parentElement;
      if (!row) continue;
      row.dataset.bibleIconToolbar = '';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.dataset.bibleMenuToggle = '';
      toggle.setAttribute('aria-label', 'Menu');
      toggle.title = 'Menu';
      toggle.setAttribute('aria-haspopup', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.innerHTML = menuIcon;
      toggle.addEventListener('click', () => {
        if (menu?.toggle === toggle) closeMenu();
        else openMenu(toggle, row);
      });
      row.after(toggle);
      // On the home page (no Home button) the book and chapter button sits
      // next to the menu button instead of inside it.
      if (!row.querySelector('button[aria-label="Home"]')) {
        bookButton.dataset.bibleBeside = '';
        const beside = document.createElement('button');
        beside.type = 'button';
        beside.dataset.bibleHeaderItem = '';
        beside.setAttribute('aria-label', bookButton.getAttribute('aria-label'));
        beside.title = bookButton.title || bookButton.getAttribute('aria-label');
        beside.innerHTML = bookButton.querySelector('svg')?.outerHTML || '';
        beside.addEventListener('click', () => { closeMenu(); bookButton.click(); });
        toggle.before(beside);
        besides.add([beside, bookButton]);
      }
    }
    for (const pair of besides) {
      const [beside, original] = pair;
      if (!beside.isConnected) { besides.delete(pair); continue; }
      if (beside.disabled !== original.disabled) beside.disabled = original.disabled;
    }
    paint();
  }
  function makeAudioControls() {
    const group = document.createElement('span');
    group.dataset.bibleAudioControls = '';
    const sound = document.createElement('button');
    const timer = document.createElement('button');
    for (const button of [sound, timer]) {
      button.type = 'button';
      button.dataset.bibleAudioControl = '';
    }
    timer.innerHTML = clock;
    sound.addEventListener('click', () => {
      if (!player) return;
      activateAudio();
      if (state.phase === 'blocked' || state.phase === 'error') {
        player.setMuted(false);
      } else player.setMuted(!state.muted);
      try { localStorage.setItem('holy-scroller-audio-muted', String(player.snapshot().muted)); } catch {}
    });
    timer.addEventListener('click', () => {
      if (!player) return;
      activateAudio();
      player.setAuto(!state.auto);
    });
    group.append(timer, sound);
    return group;
  }
  function sync() {
    frame = 0;
    mountControls();
    if (!player) return;
    const key = currentVerse();
    lastKey = key;
    if (key !== player.snapshot().key) {
      player.setActive(false);
      player.setVerse(key);
    }
    player.setActive(!document.hidden && Boolean(key));
    paint();
  }
  function requestSync() {
    if (!frame) frame = requestAnimationFrame(sync);
  }
  const observer = new MutationObserver(requestSync);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-hidden'] });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pageshow', sync);
  window.addEventListener('pagehide', () => player?.setActive(false));
  // The first Begin/filter tap enables the page's persistent audio session.
  // The catalog can still be loading; unlock now while the gesture is active.
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[data-bible-audio-controls]')) return;
    activateAudio();
  }, { capture: true });
  // Verse/view changes cancel the wait. Taps on Favorites and tiny wheel
  // movements that do not navigate must not silently disarm an enabled timer.
  mountControls();
  const response = await fetch(new URL('verses.json?v=m4a-audio-11', root));
  if (!response.ok) throw new Error(`Audio catalog returned ${response.status}`);
  const tracks = await response.json();
  player = createVersePlayer({
    audio, tracks, baseURL: audioRoot, muted: state.muted,
    onState(next) { state = next; paint(); },
    onAdvance(expectedKey) {
      if (document.hidden || currentVerse() !== expectedKey) return;
      // The current app handles this on window only when the scroller is active.
      // Use its own navigation so filters, shuffle, favorites, and history stay intact.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      requestSync();
    },
  });
  state = player.snapshot();
  sync();
}
