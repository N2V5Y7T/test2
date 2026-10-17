/**
 * The Nines — Main Entry Point
 *
 * Orchestrates: config loading → scroll container setup →
 * instant sharp hero frame reveal → scroll listener → frame loading → canvas rendering.
 */

import { buildSectionConfig, computeScrollLayout } from './config.js';
import { getScrollState } from './scroll-map.js';
import { FrameCache } from './frame-cache.js';
import { SmartLoader } from './loader.js';
import { ScrollEaser } from './scroll-easer.js';
import { Renderer } from './renderer.js';
import { DebugHUD } from './debug-hud.js';

import { buildMenuDOM, measureMenuHeights, updateMenuState } from './menu.js';
import { initListUI } from './list.js';
import { initNav, updateBottomNav } from './nav.js';
import { isScrollLocked, getLockedScrollY, onLockChange } from './scroll-lock.js';

// ── Global state ────────────────────────────────────────────────
let layout = [];
let frameCache;
let loader;
let easer;
let renderer;
let debugHUD;
let navController;
let scrollContainer;
let canvas;
let rafId = null;
let resizeTimer = null;
let lastScrollY = -1;
let viewportHeight = window.innerHeight;
let viewportWidth = window.innerWidth;
let lastState = null;

/**
 * Maps a saved (sectionIndex, segment, segmentProgress) back to its exact new scrollY
 * after font loading or viewport resize recomputes menu heights, so the user's
 * active menu and background photo never jump to a different section!
 */
function resolveScrollYForState(savedState, updatedLayout) {
  if (!savedState || !updatedLayout || !updatedLayout.length) return window.scrollY;
  const sec = updatedLayout[savedState.sectionIndex];
  if (!sec) return window.scrollY;

  const t = Math.max(0, Math.min(1, savedState.segmentProgress || 0));
  switch (savedState.segment) {
    case 'A':
      return sec.A_start + t * sec.A_length;
    case 'H':
      return sec.H_start + t * sec.H_length;
    case 'X':
      return sec.X_start + t * sec.X_length;
    case 'C':
      return sec.C_start + t * sec.C_length;
    case 'J':
      return sec.J_start + t * sec.J_length;
    default:
      return sec.scrollStart;
  }
}

function refreshLayoutHeights(preserveActiveSection = false) {
  const prevState = preserveActiveSection && layout.length > 0 && window.scrollY > 5
    ? getScrollState(window.scrollY, layout)
    : null;

  viewportHeight = window.innerHeight;
  viewportWidth = window.innerWidth;
  measureMenuHeights(layout, viewportHeight);
  layout = computeScrollLayout(layout, viewportHeight);
  if (loader) loader.setLayout(layout);
  if (navController && navController.rebuildLinks) {
    navController.rebuildLinks(layout);
  }
  if (window.__theNines) {
    window.__theNines.layout = layout;
  }
  const totalScroll = layout[layout.length - 1].scrollEnd;
  if (scrollContainer) {
    scrollContainer.style.height = `${totalScroll + viewportHeight}px`;
  }

  if (prevState && (!easer || !easer.isTweening)) {
    const newY = Math.round(resolveScrollYForState(prevState, layout));
    if (Math.abs(newY - window.scrollY) > 1) {
      if (easer) easer.snap(newY);
      window.scrollTo(0, newY);
    }
  }

  return totalScroll;
}

// ── Init ────────────────────────────────────────────────────────
async function init() {
  console.log('[The Nines] Initializing…');

  const sections = await buildSectionConfig();
  console.log(`[The Nines] ${sections.length} sections configured`);

  viewportHeight = window.innerHeight;
  viewportWidth = window.innerWidth;
  layout = computeScrollLayout(sections, viewportHeight);

  // Set up canvas & core systems
  canvas = document.getElementById('main-canvas');
  frameCache = new FrameCache();
  loader = new SmartLoader(frameCache, layout);
  easer = new ScrollEaser();
  renderer = new Renderer(canvas, frameCache);
  debugHUD = new DebugHUD();

  // Build DOM menu and measure real heights before computing initial scroll state
  scrollContainer = document.getElementById('scroll-container');
  buildMenuDOM(layout);
  const totalScroll = refreshLayoutHeights(false);
  console.log(`[The Nines] Total scroll height: ${Math.round(totalScroll)}px`);

  // Determine which section is actually on screen (supports both top load and mid-page reload)
  const initialState = getScrollState(window.scrollY, layout);
  lastState = initialState;
  const startIdx = initialState.sectionIndex;
  const startSec = layout[startIdx];
  const startFrame = Math.floor(initialState.frameFloat ?? initialState.frameIndex ?? 0);

  // Kick off loading the active section first without 19 competing placeholder requests
  loader.jumpTo(startIdx, 0.38);
  loader.finishJump();
  frameCache.prioritizeWindow(startSec.key, startFrame, 1, true);

  // Init Nav and List
  navController = initNav(layout, loader, easer);
  initListUI();

  window.__theNines = { layout, loader, easer, renderer, frameCache };

  // Re-measure heights once Google Fonts finish loading, preserving exact active section & progress
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      refreshLayoutHeights(true);
      lastScrollY = -1;
      onScroll();
    }).catch(() => {});
  }

  // Upgrade canvas immediately whenever a closer or exact frame finishes decoding
  frameCache.onFrameDecoded((key, frameIdx) => {
    if (lastState && renderer.shouldRedrawOnFrame(key, frameIdx, lastState)) {
      renderer.render(lastState, true, easer ? easer.isTweening : false);
    }
  });

  // Paint initial state and reveal immediately once the hero frame (frame0001.webp) is decoded
  await new Promise(resolve => {
    const startTime = performance.now();
    const checkReady = () => {
      const exactHeroFrame = frameCache.getFrame(startSec.key, startFrame);
      const progress = loader.getProgress(startSec.key);

      if (exactHeroFrame || progress >= 0.15 || (performance.now() - startTime > 450 && progress > 0)) {
        // Render sharp hero frame to canvas BEFORE revealing viewport so first screen is never blurry
        lastScrollY = -1;
        tick();
        document.body.classList.add('ready');
        resolve();
      } else if (performance.now() - startTime > 900) {
        lastScrollY = -1;
        tick();
        document.body.classList.add('ready');
        resolve();
      } else {
        requestAnimationFrame(checkReady);
      }
    };
    requestAnimationFrame(checkReady);
  });

  // Attach scroll & resize listeners
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  onLockChange((locked, savedY) => {
    if (easer) easer.snap(savedY);
    if (!locked) {
      lastScrollY = -1;
      onScroll();
    }
  });

  // Start staggered background warmup of remaining section holdFrame anchors & placeholders
  loader.startBackgroundWarmup();

  // Final sync render
  lastScrollY = -1;
  onScroll();

  console.log('[The Nines] Ready');
}

// ── Scroll handler ──────────────────────────────────────────────
function onScroll() {
  if (isScrollLocked()) {
    const lockedY = getLockedScrollY();
    if (Math.abs(window.scrollY - lockedY) > 0.5) {
      window.scrollTo(0, lockedY);
    }
    return;
  }
  if (rafId) return;
  rafId = requestAnimationFrame(tick);
}

function tick() {
  rafId = null;
  if (isScrollLocked()) {
    const lockedY = getLockedScrollY();
    if (easer) easer.snap(lockedY);
    if (Math.abs(window.scrollY - lockedY) > 0.5) {
      window.scrollTo(0, lockedY);
    }
    return;
  }
  const realScrollY = window.scrollY;

  const scrollY = easer ? easer.tick(realScrollY) : realScrollY;
  const isTweening = easer ? easer.isTweening : false;

  // Keep firing rAF while easing or tweening
  const stillEasing = isTweening || Math.abs(scrollY - realScrollY) > 0.15;
  if (stillEasing) {
    rafId = requestAnimationFrame(tick);
  }

  if (Math.abs(scrollY - lastScrollY) < 0.04 && !stillEasing) return;
  lastScrollY = scrollY;

  const state = getScrollState(scrollY, layout);
  lastState = state;

  renderer.render(state, false, isTweening);
  updateMenuState(state, layout, viewportHeight);
  if (!isTweening) {
    updateBottomNav(state, layout);
  }
  loader.advance(state, isTweening);

  const totalScroll = layout.length > 0 ? layout[layout.length - 1].scrollEnd : 0;
  debugHUD.update(state, scrollY, totalScroll);
}

// ── Resize handler ──────────────────────────────────────────────
function onResize() {
  const newW = window.innerWidth;
  const newH = window.innerHeight;

  // Ignore mobile URL bar height-only shifts (<160px when width is unchanged)
  if (newW === viewportWidth && Math.abs(newH - viewportHeight) < 160) {
    return;
  }

  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderer.resize(true);
    refreshLayoutHeights(true);
    lastScrollY = -1;
    onScroll();
  }, 120);
}

// ── Start ───────────────────────────────────────────────────────
init().catch(err => {
  console.error('[The Nines] Init failed:', err);
});
