// Generic sprite-sheet animator driven entirely by an atlas JSON (TexturePacker-style).
class Animator {
  constructor(atlas, image) {
    this.atlas = atlas;
    this.image = image;
    this.stateName = atlas.meta.defaultState || Object.keys(atlas.animations)[0];
    this.frameIndex = 0;
    this.elapsed = 0;
    this.flip = false;
    this.frozen = null; // { stateName, frameIndex } while held (e.g. dragging)
    this.onLoop = null; // called each time the active animation wraps back to frame 0
  }

  play(stateName, { reset = true } = {}) {
    if (!this.atlas.animations[stateName]) return;
    if (this.stateName === stateName && !reset) return;
    this.stateName = stateName;
    this.frameIndex = 0;
    this.elapsed = 0;
  }

  freeze(stateName, frameIndex = 0) {
    this.frozen = { stateName, frameIndex };
  }

  unfreeze() {
    this.frozen = null;
  }

  isFrozen() {
    return this.frozen !== null;
  }

  _frameData(stateName, frameIndex) {
    const anim = this.atlas.animations[stateName];
    const frameName = anim.frames[frameIndex];
    return this.atlas.frames[frameName];
  }

  update(dtMs) {
    if (this.frozen) return;
    const anim = this.atlas.animations[this.stateName];
    const frames = anim.frames;
    const frameData = this._frameData(this.stateName, this.frameIndex);
    const duration = frameData.duration || 125;

    this.elapsed += dtMs;
    while (this.elapsed >= duration) {
      this.elapsed -= duration;
      this.frameIndex += 1;
      if (this.frameIndex >= frames.length) {
        this.frameIndex = 0;
        if (this.onLoop) this.onLoop(this.stateName);
      }
    }
  }

  draw(ctx, canvasW, canvasH) {
    const stateName = this.frozen ? this.frozen.stateName : this.stateName;
    const frameIndex = this.frozen ? this.frozen.frameIndex : this.frameIndex;
    const fd = this._frameData(stateName, frameIndex);
    if (!fd) return;

    const { frame, spriteSourceSize, sourceSize } = fd;

    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.save();
    if (this.flip) {
      ctx.translate(canvasW, 0);
      ctx.scale(-1, 1);
    }

    // Frames that are genuinely trimmed (frame smaller than the original canvas)
    // must be re-offset by spriteSourceSize so the character doesn't jitter
    // as the trim box changes size frame to frame. Frames that already fill
    // the full source canvas are drawn as-is.
    if (frame.w !== sourceSize.w || frame.h !== sourceSize.h) {
      ctx.drawImage(
        this.image,
        frame.x, frame.y, frame.w, frame.h,
        spriteSourceSize.x, spriteSourceSize.y, frame.w, frame.h
      );
    } else {
      ctx.drawImage(
        this.image,
        frame.x, frame.y, frame.w, frame.h,
        0, 0, frame.w, frame.h
      );
    }

    ctx.restore();
  }
}
