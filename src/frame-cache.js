/**
 * The Nines — Frame Cache & Memory Manager
 *
 * Manages loading, caching, and memory eviction of section frame images.
 * Features:
 * 1. Multi-tier progressive order:
 *    - Tier 1 (Hero Anchors): holdFrame (+ neighbors) and bright entrance frame first
 *    - Tier 2 (35-40% Coarse Scrub Pass): every 3rd frame across the entire section
 *      so a 35-40% preloaded section can already scrub 0%->100% smoothly with zero gaps
 *    - Tier 3 (100% Fine Fill): remaining sub-frames filled when section is active
 * 2. True network cancellation (`img.src = ''`) when pausing/aborting scrolled-past sections
 *    so browser HTTP pipes are never clogged by old sections.
 * 3. Persistent Hero Anchor cache (`_anchors`) that retains each section's `holdFrame`
 *    even when distant sections are evicted from RAM.
 */

const HIGH_CONCURRENT_LOADS = 6;
const LOW_CONCURRENT_LOADS = 2;

/**
 * Builds a multi-tier loading order where the first ~38% of indices cover:
 * - The exact holdFrame (hero dish shot) + adjacent frames
 * - The opening frames / bright entrance anchor
 * - Every 3rd frame across the entire section (complete coarse scrub coverage)
 * And the remaining ~62% fill in every 2nd and 1st frame for 15fps sub-frame blending.
 */
function buildSmartOrder(count, holdFrame = null, isGroupIntro = false) {
  const seen = new Set();
  const order = [];
  const push = (idx) => {
    if (idx >= 0 && idx < count && !seen.has(idx)) {
      seen.add(idx);
      order.push(idx);
    }
  };

  if (isGroupIntro) {
    // Group intro (food): starts at frame 0 immediately on load
    for (let i = 0; i < Math.min(12, count); i++) {
      push(i);
    }
    push(Math.floor(count / 2));
    push(count - 1);
    for (let i = 0; i < count; i += 3) {
      push(i);
    }
    for (let i = 0; i < count; i++) {
      push(i);
    }
    return order;
  }

  // Regular menu sections:
  // 1. Hero Hold Frame first (so Segment H menu view is always crystal clear)
  if (holdFrame != null) {
    push(holdFrame);
    push(holdFrame - 1);
    push(holdFrame + 1);
  }

  // 2. Bright entrance anchor (frame 15 is past the dark fade-in) + boundaries
  push(Math.min(15, count - 1));
  push(0);
  push(count - 1);

  // 3. Coarse pass (every 3rd frame) across entrance -> hold -> exit (~32 frames = ~35% of section)
  const split = holdFrame != null ? holdFrame : Math.floor(count / 2);
  for (let i = 3; i <= split; i += 3) {
    push(i);
  }
  for (let i = split + 3; i < count; i += 3) {
    push(i);
  }

  // 4. Medium pass (every 2nd frame)
  for (let i = 0; i < count; i += 2) {
    push(i);
  }

  // 5. Fine pass (all remaining frames)
  for (let i = 0; i < count; i++) {
    push(i);
  }

  return order;
}

function pad(n) {
  return String(n + 1).padStart(4, '0'); // frames are 1-indexed on disk
}

export class FrameCache {
  constructor() {
    // sectionKey → section state
    this._sections = new Map();
    // sectionKey → Image (270x480 clean preview placeholder.webp)
    this._placeholders = new Map();
    this._placeholderLoading = new Set();
    // sectionKey → { hold: Image, entrance: Image } persistent hero anchors (never evicted)
    this._anchors = new Map();
    this._anchorLoading = new Set();
    this._frameDecodedListeners = [];
  }

  onFrameDecoded(callback) {
    this._frameDecodedListeners.push(callback);
  }

  _notifyFrameDecoded(key, frameIdx) {
    for (let i = 0; i < this._frameDecodedListeners.length; i++) {
      this._frameDecodedListeners[i](key, frameIdx);
    }
  }

  /**
   * Ensure placeholder.webp is loaded for a single section on demand.
   */
  ensurePlaceholder(sec) {
    if (!sec || this._placeholders.has(sec.key) || this._placeholderLoading.has(sec.key)) {
      return;
    }
    this._placeholderLoading.add(sec.key);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this._placeholderLoading.delete(sec.key);
      this._placeholders.set(sec.key, img);
      this._notifyFrameDecoded(sec.key, -1);
    };
    img.onerror = () => {
      this._placeholderLoading.delete(sec.key);
    };
    img.src = `${sec.framePath}placeholder.webp`;
  }

  /**
   * Staggered background preload of placeholders + hero holdFrame anchors
   * so they never compete with the initial first-screen frame0001.webp load.
   */
  preloadPlaceholders(layout, immediateIndices = [0, 1]) {
    if (!Array.isArray(layout)) return;
    for (const idx of immediateIndices) {
      if (layout[idx]) this.ensurePlaceholder(layout[idx]);
    }
  }

  /**
   * Preload the single full-resolution hero anchor frame (holdFrame, or frame 0 for group-intro)
   * into the persistent `_anchors` map.
   */
  ensureHoldAnchor(sec) {
    if (!sec) return;
    const existing = this._anchors.get(sec.key);
    if ((existing && existing.hold) || this._anchorLoading.has(sec.key)) return;

    // Check if already loaded in active section cache
    const targetIdx = sec.type === 'group-intro' ? 0 : (sec.holdFrame ?? Math.floor(sec.frameCount / 2));
    const secState = this._sections.get(sec.key);
    if (secState && secState.images.has(targetIdx)) {
      this._recordAnchor(sec.key, targetIdx, secState.images.get(targetIdx), sec.holdFrame, sec.type === 'group-intro');
      return;
    }

    this._anchorLoading.add(sec.key);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const finalize = () => {
        this._anchorLoading.delete(sec.key);
        this._recordAnchor(sec.key, targetIdx, img, sec.holdFrame, sec.type === 'group-intro');
        const activeState = this._sections.get(sec.key);
        if (activeState && !activeState.images.has(targetIdx)) {
          activeState.images.set(targetIdx, img);
          activeState.loadedCount = activeState.images.size;
        }
        this._notifyFrameDecoded(sec.key, targetIdx);
      };
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {}).finally(finalize);
      } else {
        finalize();
      }
    };
    img.onerror = () => {
      this._anchorLoading.delete(sec.key);
    };
    img.src = `${sec.framePath}frame${pad(targetIdx)}.webp`;
  }

  _recordAnchor(key, frameIdx, img, holdFrame, isGroupIntro) {
    let entry = this._anchors.get(key);
    if (!entry) {
      entry = { hold: null, entrance: null, holdIndex: holdFrame ?? 0 };
      this._anchors.set(key, entry);
    }
    if (isGroupIntro && frameIdx === 0) {
      entry.hold = img;
      entry.entrance = img;
      entry.holdIndex = 0;
    } else if (holdFrame != null && frameIdx === holdFrame) {
      entry.hold = img;
      entry.holdIndex = holdFrame;
    } else if (frameIdx >= 12 && frameIdx <= 20 && !entry.entrance) {
      entry.entrance = img;
    }
  }

  getPlaceholder(key) {
    return this._placeholders.get(key) || null;
  }

  getAnchor(key, targetFrame = null) {
    const entry = this._anchors.get(key);
    if (!entry) return null;
    if (targetFrame != null && targetFrame < 24 && entry.entrance) {
      return entry.entrance;
    }
    return entry.hold || entry.entrance || null;
  }

  /**
   * Start or update loading frames for a section up to `maxRatio` (e.g. 0.38 for 38% preload, 1.0 for full).
   *
   * @param {string} key - section key
   * @param {string} framePath - e.g. './frames/first-course/'
   * @param {number} frameCount - total frames
   * @param {string} priority - 'high' | 'low'
   * @param {number|null} holdFrame - section hold frame index
   * @param {number} maxRatio - fraction of frames to load (0.0 to 1.0)
   * @param {boolean} isGroupIntro - whether this is the opening group-intro section
   * @returns {object} section state
   */
  loadSection(
    key,
    framePath,
    frameCount,
    priority = 'high',
    holdFrame = null,
    maxRatio = 1.0,
    isGroupIntro = false
  ) {
    const targetCount = Math.max(4, Math.min(frameCount, Math.ceil(frameCount * maxRatio)));

    if (this._sections.has(key)) {
      const existing = this._sections.get(key);
      existing.priority = priority;
      existing.paused = false;
      if (targetCount > existing.targetCount) {
        existing.targetCount = targetCount;
      }
      if (existing.abortController.signal.aborted) {
        existing.abortController = new AbortController();
      }
      if (existing.queue.length === 0 && existing.images.size < frameCount) {
        const fullOrder = buildSmartOrder(frameCount, holdFrame, isGroupIntro);
        existing.queue = fullOrder.filter(idx => !existing.images.has(idx) && !existing.inFlight.has(idx));
      }
      this._pump(existing);
      return existing;
    }

    const ac = new AbortController();
    const images = new Map();
    // Seed with any already-cached anchor frame so we never re-fetch holdFrame
    const cachedAnchor = this._anchors.get(key);
    if (cachedAnchor && cachedAnchor.hold && cachedAnchor.holdIndex != null) {
      images.set(cachedAnchor.holdIndex, cachedAnchor.hold);
    }

    const inFlight = new Map(); // frameIdx -> HTMLImageElement
    const order = buildSmartOrder(frameCount, holdFrame, isGroupIntro).filter(idx => !images.has(idx));

    const state = {
      key,
      framePath,
      frameCount,
      holdFrame,
      isGroupIntro,
      images,
      inFlight,
      queue: order,
      loading: true,
      paused: false,
      loadedCount: images.size,
      targetCount,
      activeWorkers: 0,
      priority,
      abortController: ac,
    };
    this._sections.set(key, state);

    this._pump(state);
    return state;
  }

  _pump(state) {
    if (state.abortController.signal.aborted || state.paused) return;

    const maxWorkers = state.priority === 'high' ? HIGH_CONCURRENT_LOADS : LOW_CONCURRENT_LOADS;

    while (
      state.activeWorkers < maxWorkers &&
      state.queue.length > 0 &&
      (state.images.size + state.inFlight.size) < state.targetCount
    ) {
      const frameIdx = state.queue.shift();

      if (state.images.has(frameIdx) || state.inFlight.has(frameIdx)) {
        continue;
      }

      const img = new Image();
      img.decoding = 'async';
      if (state.priority === 'high') {
        img.fetchPriority = 'high';
      } else {
        img.fetchPriority = 'low';
      }

      state.inFlight.set(frameIdx, img);
      state.activeWorkers++;

      const onSlotFree = () => {
        if (state.inFlight.get(frameIdx) === img) {
          state.inFlight.delete(frameIdx);
          state.activeWorkers = Math.max(0, state.activeWorkers - 1);
        }
        if (
          state.queue.length === 0 ||
          (state.images.size >= state.targetCount && state.activeWorkers === 0)
        ) {
          state.loading = false;
        }
        if (!state.paused && !state.abortController.signal.aborted) {
          this._pump(state);
        }
      };

      img.onload = () => {
        if (state.abortController.signal.aborted || state.paused) {
          onSlotFree();
          return;
        }

        const commitImage = () => {
          if (!state.abortController.signal.aborted) {
            state.images.set(frameIdx, img);
            state.loadedCount = state.images.size;
            this._recordAnchor(state.key, frameIdx, img, state.holdFrame, state.isGroupIntro);
            this._notifyFrameDecoded(state.key, frameIdx);
          }
          onSlotFree();
        };

        if (typeof img.decode === 'function') {
          img.decode().catch(() => {}).finally(commitImage);
        } else {
          commitImage();
        }
      };

      img.onerror = () => {
        onSlotFree();
      };

      img.src = `${state.framePath}frame${pad(frameIdx)}.webp`;
    }

    if (state.activeWorkers === 0 && (state.queue.length === 0 || state.images.size >= state.targetCount)) {
      state.loading = false;
    }
  }

  /**
   * Prioritize a window of upcoming frames in the direction of scroll,
   * while ALWAYS keeping `holdFrame` at the front if not yet loaded.
   */
  prioritizeWindow(key, currentFrameIndex, direction = 1, promoteToFull = true) {
    const state = this._sections.get(key);
    if (!state || state.abortController.signal.aborted) return;

    if (promoteToFull) {
      state.targetCount = state.frameCount;
      state.priority = 'high';
      state.paused = false;
    }

    if (!state.queue || state.queue.length === 0) {
      this._pump(state);
      return;
    }

    const count = state.frameCount;
    const center = Math.max(0, Math.min(count - 1, Math.round(currentFrameIndex || 0)));

    if (state._lastPrioritizedCenter !== undefined && Math.abs(state._lastPrioritizedCenter - center) < 2) {
      this._pump(state);
      return;
    }
    state._lastPrioritizedCenter = center;

    const priorityFrames = [];
    const seen = new Set();
    const addPriority = (idx) => {
      if (idx >= 0 && idx < count && !seen.has(idx) && !state.images.has(idx) && !state.inFlight.has(idx)) {
        seen.add(idx);
        priorityFrames.push(idx);
      }
    };

    // Always keep exact target frame and holdFrame at the very top of the queue
    addPriority(center);
    if (state.holdFrame != null) {
      addPriority(state.holdFrame);
    }

    const spanAhead = 10;
    const spanBehind = 3;

    if (direction >= 0) {
      for (let i = 1; i <= spanAhead; i++) addPriority(center + i);
      for (let i = 1; i <= spanBehind; i++) addPriority(center - i);
    } else {
      for (let i = 1; i <= spanAhead; i++) addPriority(center - i);
      for (let i = 1; i <= spanBehind; i++) addPriority(center + i);
    }

    if (priorityFrames.length > 0) {
      state.queue = priorityFrames.concat(state.queue.filter(idx => !seen.has(idx)));
    }
    this._pump(state);
  }

  /**
   * Pause a section's in-flight downloads and re-queue unfinished frames.
   * Immediately frees browser HTTP connections when the user scrolls past a section.
   */
  pauseSection(key) {
    const state = this._sections.get(key);
    if (!state) return;
    state.paused = true;
    state.loading = false;
    state.priority = 'low';

    if (state.inFlight.size > 0) {
      const requeue = [];
      for (const [frameIdx, img] of state.inFlight.entries()) {
        img.onload = null;
        img.onerror = null;
        img.src = '';
        requeue.push(frameIdx);
      }
      state.inFlight.clear();
      state.activeWorkers = 0;
      state.queue = requeue.concat(state.queue);
    }
  }

  abortSection(key) {
    const state = this._sections.get(key);
    if (state) {
      state.abortController.abort();
      state.paused = true;
      state.loading = false;
      for (const [, img] of state.inFlight.entries()) {
        img.onload = null;
        img.onerror = null;
        img.src = '';
      }
      state.inFlight.clear();
      state.activeWorkers = 0;
      state.queue = [];
    }
  }

  hasSection(key) {
    return this._sections.has(key);
  }

  getProgress(key) {
    const state = this._sections.get(key);
    if (!state) return 0;
    return state.loadedCount / state.frameCount;
  }

  getFrame(key, frameIndex) {
    const state = this._sections.get(key);
    if (state && state.images.has(frameIndex)) {
      return state.images.get(frameIndex);
    }
    const anchor = this._anchors.get(key);
    if (anchor && anchor.holdIndex === frameIndex && anchor.hold) {
      return anchor.hold;
    }
    return null;
  }

  /**
   * Returns `{ img, index, isExact }` for the closest loaded frame to `frameIndex`.
   * Avoids returning dark fade-in frames (indices 0..7) when `frameIndex >= 14`
   * in regular dish sections so Segment H (Hold) never flashes dark/black.
   */
  nearestFrameInfo(key, frameIndex) {
    const state = this._sections.get(key);
    const target = Math.max(0, Math.round(Number(frameIndex) || 0));

    if (state && state.images.has(target)) {
      return { img: state.images.get(target), index: target, isExact: true };
    }

    const anchor = this._anchors.get(key);
    if (anchor && anchor.holdIndex === target && anchor.hold) {
      return { img: anchor.hold, index: target, isExact: true };
    }

    if (state && state.loadedCount > 0) {
      const count = state.frameCount;
      const clampedTarget = Math.min(count - 1, target);
      const minAcceptableIdx = (!state.isGroupIntro && clampedTarget >= 14) ? 8 : 0;

      for (let d = 1; d < count; d++) {
        const left = clampedTarget - d;
        const right = clampedTarget + d;
        if (right < count && right >= minAcceptableIdx && state.images.has(right)) {
          return { img: state.images.get(right), index: right, isExact: false };
        }
        if (left >= minAcceptableIdx && state.images.has(left)) {
          return { img: state.images.get(left), index: left, isExact: false };
        }
      }
    }

    if (anchor && (anchor.hold || anchor.entrance)) {
      const img = (target < 24 && anchor.entrance) ? anchor.entrance : (anchor.hold || anchor.entrance);
      return { img, index: anchor.holdIndex ?? 0, isExact: false };
    }

    return null;
  }

  nearestFrame(key, frameIndex) {
    const info = this.nearestFrameInfo(key, frameIndex);
    return info ? info.img : null;
  }

  /**
   * Unload a section's decoded Image objects so mobile memory stays bounded,
   * while preserving its hero holdFrame in `this._anchors` for instant revisit.
   */
  unloadSection(key) {
    const state = this._sections.get(key);
    if (!state) return;
    if (state.holdFrame != null && state.images.has(state.holdFrame)) {
      this._recordAnchor(key, state.holdFrame, state.images.get(state.holdFrame), state.holdFrame, state.isGroupIntro);
    } else if (state.isGroupIntro && state.images.has(0)) {
      this._recordAnchor(key, 0, state.images.get(0), 0, true);
    }
    this.abortSection(key);
    state.images.clear();
    this._sections.delete(key);
  }
}
