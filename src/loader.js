/**
 * The Nines — Smart Loading Queue & Memory Window Manager
 *
 * Implements a adaptive two-stage preloading strategy:
 *   1. ACTIVE SECTION (idx)      — 100% loaded at HIGH priority
 *   2. NEXT SECTION (idx + 1)    — Preloads 38% (holdFrame + coarse scrub pass) immediately;
 *                                  promotes to 100% once user is ≥35% through current section
 *   3. LOOKAHEAD (idx + 2)       — Preloads 35% once user is ≥35% through current section
 *   4. SCROLLED-PAST SECTIONS    — Immediately paused (`img.src = ''`) if >1 section behind
 *                                  so old downloads never starve the current screen;
 *                                  evicted from RAM beyond 3 sections while retaining hero holdFrame.
 *   5. BACKGROUND ANCHOR WARMUP  — Trickles each section's single hero `holdFrame` + `placeholder.webp`
 *                                  after initial ready so direct fast scrolling to any section is instant.
 */

const MAX_ACTIVE_SECTION_DISTANCE = 3;
const PRELOAD_PARTIAL_RATIO = 0.38; // 38% preload covers holdFrame + full coarse scrub pass

export class SmartLoader {
  /**
   * @param {import('./frame-cache.js').FrameCache} frameCache
   * @param {Array} layout — from computeScrollLayout
   */
  constructor(frameCache, layout) {
    this._cache = frameCache;
    this._layout = layout;
    this._queued = new Set();
    this._lastIdx = -1;
    this._jumping = false;
    this._warmupStarted = false;
  }

  setLayout(layout) {
    this._layout = layout;
  }

  /**
   * Starts staggered background warmup of placeholders and hero holdFrame anchors
   * across all sections AFTER the first screen is already sharp and visible.
   */
  startBackgroundWarmup() {
    if (this._warmupStarted) return;
    this._warmupStarted = true;

    let cursor = 0;
    const step = () => {
      if (cursor >= this._layout.length) return;
      const sec = this._layout[cursor++];
      if (sec) {
        this._cache.ensurePlaceholder(sec);
        this._cache.ensureHoldAnchor(sec);
      }
      setTimeout(step, 90);
    };
    setTimeout(step, 120);
  }

  /**
   * Called on every scroll tick with the current scroll state.
   */
  advance(state, isTweening = false) {
    if (isTweening || this._jumping) return;

    const idx = state.sectionIndex;
    const sec = this._layout[idx];
    if (!sec) return;

    // Ensure placeholders & hold anchors exist for current + nearby sections
    this._cache.ensurePlaceholder(sec);
    if (idx + 1 < this._layout.length) {
      this._cache.ensurePlaceholder(this._layout[idx + 1]);
      this._cache.ensureHoldAnchor(this._layout[idx + 1]);
    }

    // 1. Current section always loads 100% at HIGH priority
    this._ensureLoaded(idx, 'high', 1.0);

    // Determine whether user is ≥35% into the current section
    const past35Percent =
      state.segment === 'H' ||
      state.segment === 'X' ||
      state.segment === 'C' ||
      state.segment === 'J' ||
      (state.segment === 'A' && state.segmentProgress >= 0.35);

    const nearExit =
      state.segment === 'X' ||
      state.segment === 'C' ||
      state.segment === 'J' ||
      (state.segment === 'H' && state.segmentProgress >= 0.55);

    // 2. Next section (idx + 1):
    //    - Early in current section (<35%): preload 38% (holdFrame + coarse pass) at low priority
    //    - Past 35% of current section: promote to 100% so handoff is completely seamless
    if (idx + 1 < this._layout.length) {
      const nextRatio = past35Percent ? 1.0 : PRELOAD_PARTIAL_RATIO;
      const nextPriority = nearExit ? 'high' : 'low';
      this._ensureLoaded(idx + 1, nextPriority, nextRatio);
    }

    // 3. Lookahead section (idx + 2):
    //    - Preload 38% once user is past 35% of current section
    if (past35Percent && idx + 2 < this._layout.length) {
      this._cache.ensurePlaceholder(this._layout[idx + 2]);
      this._cache.ensureHoldAnchor(this._layout[idx + 2]);
      this._ensureLoaded(idx + 2, 'low', PRELOAD_PARTIAL_RATIO);
    }

    // 4. Immediately pause bandwidth on sections the user scrolled past, and evict distant RAM
    if (idx !== this._lastIdx) {
      this._lastIdx = idx;
      this._manageWindow(idx);
    }
  }

  /**
   * Nav jump: immediately promote destination to CRITICAL priority,
   * pause/abort intermediate downloads so 100% of bandwidth serves the destination.
   */
  jumpTo(destIdx, preloadNextRatio = PRELOAD_PARTIAL_RATIO) {
    const dest = this._layout[destIdx];
    if (!dest) return;

    this._jumping = true;

    for (const key of [...this._queued]) {
      const secIdx = this._layout.findIndex(s => s.key === key);
      if (secIdx < 0) continue;
      if (Math.abs(secIdx - destIdx) > 2) {
        this._cache.unloadSection(key);
        this._queued.delete(key);
      } else if (secIdx !== destIdx) {
        this._cache.pauseSection(key);
      }
    }

    this._cache.ensurePlaceholder(dest);
    this._cache.ensureHoldAnchor(dest);

    // Load destination at high priority (100%) and prioritize its holdFrame window
    this._ensureLoaded(destIdx, 'high', 1.0);
    const targetFrame = dest.type === 'group-intro' ? 0 : (dest.holdFrame || 0);
    this._cache.prioritizeWindow(dest.key, targetFrame, 1, true);

    // Preload 38% of next section and previous section at low priority
    if (destIdx + 1 < this._layout.length) {
      this._cache.ensurePlaceholder(this._layout[destIdx + 1]);
      this._cache.ensureHoldAnchor(this._layout[destIdx + 1]);
      this._ensureLoaded(destIdx + 1, 'low', preloadNextRatio);
    }
    if (destIdx - 1 >= 0) {
      this._cache.ensurePlaceholder(this._layout[destIdx - 1]);
      this._ensureLoaded(destIdx - 1, 'low', PRELOAD_PARTIAL_RATIO);
    }
  }

  finishJump() {
    this._jumping = false;
  }

  getProgress(key) {
    return this._cache.getProgress(key);
  }

  _manageWindow(centerIdx) {
    for (const key of [...this._queued]) {
      const secIdx = this._layout.findIndex(s => s.key === key);
      if (secIdx < 0) continue;

      const dist = Math.abs(secIdx - centerIdx);
      if (dist > MAX_ACTIVE_SECTION_DISTANCE) {
        this._cache.unloadSection(key);
        this._queued.delete(key);
      } else if (secIdx < centerIdx - 1 || secIdx > centerIdx + 2) {
        // Immediately stop in-flight HTTP downloads for sections outside [centerIdx-1, centerIdx+2]
        this._cache.pauseSection(key);
      } else if (secIdx === centerIdx - 1) {
        // Downgrade the section behind us so it never steals workers from centerIdx
        const state = this._cache._sections.get(key);
        if (state && state.priority === 'high') {
          state.priority = 'low';
        }
      }
    }
  }

  _ensureLoaded(idx, priority, maxRatio = 1.0) {
    if (idx < 0 || idx >= this._layout.length) return;
    const sec = this._layout[idx];
    this._queued.add(sec.key);
    this._cache.loadSection(
      sec.key,
      sec.framePath,
      sec.frameCount,
      priority,
      sec.holdFrame,
      maxRatio,
      sec.type === 'group-intro'
    );
  }
}
