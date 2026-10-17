/**
 * The Nines — Canvas Renderer
 *
 * Draws video frames to the main canvas, handles cross-dissolve,
 * uses velocity-aware sub-frame blending, and tracks exact vs fallback frames
 * so decoded frames upgrade the canvas immediately without ever getting stuck
 * on a placeholder or an earlier section's image.
 */

const MAX_DPR = 2;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./frame-cache.js').FrameCache} frameCache
   */
  constructor(canvas, frameCache) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.frameCache = frameCache;
    this._lastDrawnKey = null;
    this._lastDrawnFrame = -1;
    this._lastDrawnActualFrame = -1;
    this._lastDrawnIsExact = false;
    this._lastDrawnFloat = -1;
    this._lastValidImage = null;

    this.resize(true);
  }

  /**
   * Set canvas dimensions based on viewport, capped at DPR 2.
   */
  resize(force = false) {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const rect = this.canvas.getBoundingClientRect();

    const w = Math.round(rect.width || window.innerWidth);
    const screenH = typeof window !== 'undefined' && window.screen && window.screen.height
      ? window.screen.height
      : window.innerHeight;
    const h = Math.round(Math.max(rect.height || window.innerHeight, screenH));

    // Ignore mobile browser toolbar show/hide height-only changes (<180px)
    if (
      !force &&
      this._lastWidth === w &&
      this._lastDpr === dpr &&
      Math.abs((this._lastHeight || 0) - h) < 180
    ) {
      return;
    }

    if (this._lastWidth === w && this._lastHeight === h && this._lastDpr === dpr) {
      return;
    }

    this._lastWidth = w;
    this._lastHeight = h;
    this._lastDpr = dpr;

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    this._displayWidth = w;
    this._displayHeight = h;

    this._lastDrawnKey = null;
    this._lastDrawnFrame = -1;
    this._lastDrawnActualFrame = -1;
    this._lastDrawnIsExact = false;
    this._lastDrawnFloat = -1;
    if (this._lastValidImage) {
      this.ctx.globalAlpha = 1;
      this._drawImageCover(this._lastValidImage);
    }
  }

  /**
   * Returns true if a newly decoded frame (`frameIdx` in section `key`)
   * improves upon what is currently painted on the canvas for `state`.
   */
  shouldRedrawOnFrame(key, frameIdx, state) {
    if (!state || !state.section) return false;

    if (state.crossDissolve && state.crossDissolve.nextSection && state.crossDissolve.nextSection.key === key) {
      return true;
    }

    if (state.section.key !== key) return false;

    // If we are currently displaying a placeholder or non-exact fallback frame,
    // redraw whenever ANY closer frame (or placeholder) decodes!
    if (!this._lastDrawnIsExact || this._lastDrawnKey !== key) {
      if (frameIdx < 0) return this._lastDrawnActualFrame < 0;
      const targetIdx = Math.round(state.frameFloat !== undefined ? state.frameFloat : state.frameIndex);
      if (this._lastDrawnActualFrame < 0) return true;
      return Math.abs(frameIdx - targetIdx) <= Math.abs(this._lastDrawnActualFrame - targetIdx);
    }

    const activeIdx = Math.floor(state.frameFloat !== undefined ? state.frameFloat : state.frameIndex);
    return Math.abs(activeIdx - frameIdx) <= 1;
  }

  /**
   * Render the current scroll state to the canvas.
   *
   * @param {object} state - from getScrollState()
   * @param {boolean} force - force redraw even if scroll position unchanged
   * @param {boolean} isTweening - true during programmatic nav jump
   */
  render(state, force = false, isTweening = false) {
    const { section, crossDissolve } = state;
    const key = section.key;
    const frameFloat = state.frameFloat !== undefined ? state.frameFloat : state.frameIndex;
    const frameIndex = Math.floor(frameFloat);

    // Prioritize upcoming frames in direction of motion (skip intermediate sections during nav jumps)
    const direction = this._lastFrameIndex !== undefined ? (frameIndex >= this._lastFrameIndex ? 1 : -1) : 1;
    this._lastFrameIndex = frameIndex;
    if (!isTweening) {
      this.frameCache.prioritizeWindow(key, frameIndex, direction, true);
    }

    if (crossDissolve) {
      // Do not promote nextSection to full or push its holdFrame behind frame 0 during cross-dissolve
      this._renderCrossDissolve(
        key, frameFloat,
        crossDissolve.nextSection.key, 0,
        crossDissolve.progress,
        section,
        crossDissolve.nextSection
      );
    } else {
      this._renderFrame(key, frameFloat, section, force);
    }
  }

  /**
   * Draw a frame from a section with velocity-aware sub-frame continuous blending.
   */
  _renderFrame(sectionKey, frameFloat, section, force = false) {
    const count = section.frameCount;
    const clampedFloat = Math.max(0, Math.min(count - 1, frameFloat));
    const floorIndex = Math.floor(clampedFloat);
    const ceilIndex = Math.min(count - 1, floorIndex + 1);
    const blendAlpha = clampedFloat - floorIndex;

    if (
      !force &&
      this._lastDrawnKey === sectionKey &&
      this._lastDrawnIsExact &&
      Math.abs(this._lastDrawnFloat - clampedFloat) < 0.004
    ) {
      return;
    }

    const frameDelta = this._lastDrawnKey === sectionKey && this._lastDrawnFloat >= 0
      ? Math.abs(clampedFloat - this._lastDrawnFloat)
      : 0;

    // When stationary / settled (frameDelta <= 0.04), lock to the nearest clean integer frame
    const primaryIndex = (frameDelta <= 0.04 && blendAlpha >= 0.5) ? ceilIndex : floorIndex;
    const info = this.frameCache.nearestFrameInfo(sectionKey, primaryIndex);

    if (!info || !info.img) {
      this._drawPlaceholder(section);
      return;
    }

    this.ctx.globalAlpha = 1;
    this._drawImageCover(info.img);
    this._lastValidImage = info.img;

    // Optical blend: only blend adjacent frames during active moderate scrubbing when exact frames are ready
    if (
      info.isExact &&
      frameDelta > 0.04 &&
      frameDelta < 0.65 &&
      blendAlpha > 0.04 &&
      blendAlpha < 0.96 &&
      ceilIndex !== floorIndex
    ) {
      const imgCeil = this.frameCache.getFrame(sectionKey, ceilIndex);
      if (imgCeil) {
        this.ctx.globalAlpha = blendAlpha;
        this._drawImageCover(imgCeil);
        this.ctx.globalAlpha = 1;
      }
    }

    this._lastDrawnKey = sectionKey;
    this._lastDrawnFloat = clampedFloat;
    this._lastDrawnFrame = primaryIndex;
    this._lastDrawnActualFrame = info.index;
    this._lastDrawnIsExact = info.isExact;
  }

  /**
   * Draw the section's own anchor or 270x480 preview placeholder.webp.
   * Never draws a completely different section's image when stationary on a new section.
   */
  _drawPlaceholder(section) {
    if (section) {
      const anchor = this.frameCache.getAnchor(section.key, section.holdFrame);
      if (anchor) {
        this.ctx.globalAlpha = 1;
        this._drawImageCover(anchor);
        this._lastValidImage = anchor;
        this._lastDrawnKey = section.key;
        this._lastDrawnActualFrame = section.holdFrame ?? 0;
        this._lastDrawnIsExact = false;
        return;
      }

      const ph = this.frameCache.getPlaceholder(section.key);
      if (ph) {
        this.ctx.globalAlpha = 1;
        this._drawImageCover(ph);
        this._lastValidImage = ph;
        this._lastDrawnKey = section.key;
        this._lastDrawnActualFrame = -1;
        this._lastDrawnIsExact = false;
        return;
      }
      // Request placeholder immediately if not yet requested
      this.frameCache.ensurePlaceholder(section);
    }

    if (this._lastValidImage) {
      this.ctx.globalAlpha = 1;
      this._drawImageCover(this._lastValidImage);
      this._lastDrawnKey = section ? section.key : null;
      this._lastDrawnActualFrame = -1;
      this._lastDrawnIsExact = false;
      return;
    }

    this.ctx.fillStyle = '#0a0a0a';
    this.ctx.fillRect(0, 0, this._displayWidth, this._displayHeight);
  }

  /**
   * Cross-dissolve between two frames from different sections.
   */
  _renderCrossDissolve(keyA, frameFloatA, keyB, frameFloatB, progress, secA, secB) {
    const floorA = Math.floor(Math.max(0, frameFloatA));
    const floorB = Math.floor(Math.max(0, frameFloatB));
    const imgA = this.frameCache.nearestFrame(keyA, floorA)
      || (secA && this.frameCache.getPlaceholder(secA.key))
      || this._lastValidImage;
    const imgB = this.frameCache.getFrame(keyB, floorB)
      || this.frameCache.nearestFrame(keyB, floorB)
      || (secB && this.frameCache.getPlaceholder(secB.key));

    if (imgA) {
      this.ctx.globalAlpha = 1;
      this._drawImageCover(imgA);
      this._lastValidImage = imgA;
    } else {
      this.ctx.fillStyle = '#0a0a0a';
      this.ctx.fillRect(0, 0, this._displayWidth, this._displayHeight);
    }

    if (imgB && progress > 0) {
      const alpha = Math.max(0, Math.min(1, progress));
      this.ctx.globalAlpha = alpha;
      this._drawImageCover(imgB);
      this.ctx.globalAlpha = 1;
      if (progress >= 0.5) {
        this._lastValidImage = imgB;
      }
    }

    this._lastDrawnKey = null;
    this._lastDrawnFloat = -1;
    this._lastDrawnFrame = -1;
    this._lastDrawnActualFrame = -1;
    this._lastDrawnIsExact = false;
  }

  /**
   * Draw an image covering the canvas (object-fit: cover).
   */
  _drawImageCover(img) {
    const cw = this._displayWidth;
    const ch = this._displayHeight;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;

    const canvasRatio = cw / ch;
    const imageRatio = iw / ih;

    let sx, sy, sw, sh;
    if (imageRatio > canvasRatio) {
      sh = ih;
      sw = ih * canvasRatio;
      sx = (iw - sw) / 2;
      sy = 0;
    } else {
      sw = iw;
      sh = iw / canvasRatio;
      sx = 0;
      sy = (ih - sh) / 2;
    }

    this.ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
  }
}
