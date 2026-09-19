'use strict';
// Turns hinge samples into a lid tilt, in radians, for the overlay to render.
//
// Tilt is how far the lid has turned away from an anchor — the angle it rested
// at. While the lid moves the anchor holds, so tilt tracks the motion. Once the
// lid is still, the anchor glides over to it and tilt eases back to zero.
//
// Smoothness comes from three stages, each continuous so nothing ever steps:
//   1. a short low-pass takes the staircase out of sparse whole-degree samples;
//   2. a backlash band swallows sensor rattle: the angle only moves once the
//      reading pushes past the band's edge, and then moves continuously with
//      it, so a parked lid reads perfectly still instead of twitching;
//   3. critically damped springs drive both tilt and the anchor, so speed
//      changes gradually and the blur never lurches or bounces.
(function (root) {
  const DEFAULTS = {
    smoothMs: 25,    // low-pass time constant on raw samples
    rattleDeg: 2,    // readings within this of the settled angle are rattle
    holdMs: 1000,    // lid still this long before the blur starts easing away
    tiltHz: 5,       // how closely tilt follows the lid
    settleHz: 3,     // how quickly the blur eases away once the lid is still
    // Opening the lid wants the screen back straight away, so after an opening
    // move the blur skips the hold and clears fast.
    openHoldMs: 110,
    openSettleHz: 5,
    // The sensor only reports when the angle changes, so silence means either a
    // stopped lid or a gap between samples. Stillness therefore has to outlast
    // the gaps this sensor actually produces, or a moving lid reads as stopped
    // between samples and the blur clears and blooms once per sample. The gap
    // is measured as it goes, so slow hardware (~4Hz) and fast both behave.
    gapFactor: 1.8,
    gapSeedMs: 250,
    gapMaxMs: 600,
  };
  const DEG = Math.PI / 180;
  const SUBSTEP_S = 0.004;

  function create(options) {
    const c  = Object.assign({}, DEFAULTS, options);
    const wT = 2 * Math.PI * c.tiltHz;
    const wA = 2 * Math.PI * c.settleHz;
    const wOpen = 2 * Math.PI * c.openSettleHz;
    // Explicit spring integration goes unstable once w * step nears 2.
    const substep = Math.min(SUBSTEP_S, 0.25 / Math.max(wT, wA, wOpen));

    let raw = null, filtered = 0, angle = 0;
    let anchor = 0, anchorVel = 0, tilt = 0, tiltVel = 0, stillMs = 0, stillFrom = 0;
    // Direction is settled when a move starts and held for that move. Deciding
    // it every frame let it flip as the anchor drifted past the angle, which
    // swapped the timings mid-flight and bounced the blur.
    let opening = false;
    let nowMs = 0, lastSampleMs = null, gapMs = c.gapSeedMs;
    // Moving means travelling further than the rattle band can shift the angle
    // on its own; a settling reading nudging across the band isn't movement.
    const moveDeg = c.rattleDeg + 0.5;

    function reset(anchorDeg, angleDeg) {
      raw = Number.isFinite(angleDeg) ? angleDeg : anchorDeg;
      filtered = raw; angle = raw; stillFrom = raw;
      anchor = anchorDeg; anchorVel = 0;
      tilt = 0; tiltVel = 0; stillMs = 0;
      opening = angle > anchor;
      nowMs = 0; lastSampleMs = null; gapMs = c.gapSeedMs;
    }

    function sample(deg) {
      if (!Number.isFinite(deg)) return;
      // A repeat carries no news — the sensor only speaks when the angle moves.
      if (raw !== null && deg === raw) return;
      if (lastSampleMs !== null) {
        const gap = Math.min(nowMs - lastSampleMs, c.gapMaxMs);
        if (gap > 0) gapMs += (gap - gapMs) * 0.35;
      }
      lastSampleMs = nowMs;
      raw = deg;
    }

    function spring(x, v, target, w, h) {
      v += (w * w * (target - x) - 2 * w * v) * h;
      return [x + v * h, v];
    }

    function step(dtMs) {
      if (raw === null || !(dtMs > 0)) return;
      nowMs += dtMs;

      filtered += (raw - filtered) * (1 - Math.exp(-dtMs / c.smoothMs));
      angle = Math.min(Math.max(angle, filtered - c.rattleDeg), filtered + c.rattleDeg);

      if (Math.abs(angle - stillFrom) > moveDeg) {
        opening = angle > anchor;
        stillFrom = angle;
        stillMs = 0;
      } else stillMs += dtMs;
      const still = stillMs >= holdFor();

      let left = dtMs / 1000;
      while (left > 1e-9) {
        const h = Math.min(substep, left);
        left -= h;
        const wasBehind = anchor - angle;
        if (still) {
          [anchor, anchorVel] = spring(anchor, anchorVel, angle, opening ? wOpen : wA, h);
          // Homing in carries speed, and coasting past the lid would tilt the
          // picture the other way and bloom the blur again after it had gone.
          // It lands exactly where the blur is invisible, so stopping dead here
          // can't be seen.
          if ((anchor - angle) * wasBehind < 0) { anchor = angle; anchorVel = 0; }
        } else {
          // Lid moving again mid-retract: bleed off the anchor's speed rather
          // than stopping it dead, so the blur doesn't lurch.
          anchorVel *= Math.exp(-12 * h);
          anchor += anchorVel * h;
        }
        const wasTilted = tilt;
        [tilt, tiltVel] = spring(tilt, tiltVel, (anchor - angle) * DEG, wT, h);
        if (still && tilt * wasTilted < 0) { tilt = 0; tiltVel = 0; }
      }
    }

    // Silence has to outlast the gaps between this sensor's samples before it
    // counts as a stopped lid.
    function holdFor() {
      return Math.max(opening ? c.openHoldMs : c.holdMs, c.gapFactor * gapMs);
    }

    // Visually gone and at rest: safe to hand the real desktop back.
    function idle() {
      return stillMs >= Math.min(c.holdMs, holdFor()) &&
             Math.abs(anchor - angle) < 0.05 &&
             Math.abs(tilt) < 0.001 && Math.abs(tiltVel) < 0.005;
    }

    return { reset, sample, step, idle, tilt: () => tilt };
  }

  const api = { create, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LidMotion = api;
})(this);
