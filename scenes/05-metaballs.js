(function(){
  "use strict";

  // ---- tiny seeded RNG (mulberry32) ----
  function makeRng(seed){
    var s = seed >>> 0;
    return function(){
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Convert HSV -> [r,g,b] (0..255). Inputs 0..1.
  function hsv(h, s, v){
    h = ((h % 1) + 1) % 1;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var u = v * (1 - (1 - f) * s);
    var r, g, b;
    switch (i % 6){
      case 0: r = v; g = u; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = u; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = u; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return [r * 255 | 0, g * 255 | 0, b * 255 | 0];
  }

  function makeBlobs(rng, n){
    var blobs = [];
    for (var i = 0; i < n; i++){
      blobs.push({
        // base anchor spread across the WHOLE frame (not clustered at center)
        bx: rng(), by: rng(),
        // layered sinusoidal drift params (smooth, slowly de-phasing motion)
        ax1: 0.16 + rng() * 0.26,   // horizontal amplitude (fraction of w)
        ay1: 0.18 + rng() * 0.28,   // vertical amplitude (fraction of h)
        sx1: 0.018 + rng() * 0.05,  // x speed
        sy1: 0.014 + rng() * 0.045, // y speed
        px1: rng() * Math.PI * 2,
        py1: rng() * Math.PI * 2,
        ax2: 0.05 + rng() * 0.10,
        ay2: 0.06 + rng() * 0.11,
        sx2: 0.06 + rng() * 0.10,
        sy2: 0.05 + rng() * 0.09,
        px2: rng() * Math.PI * 2,
        py2: rng() * Math.PI * 2,
        // radius pulse (gooey breathing)
        rBase: 0.15 + rng() * 0.13,  // fraction of minDim
        rPulse: 0.03 + rng() * 0.05,
        rSpd: 0.05 + rng() * 0.12,
        rPh: rng() * Math.PI * 2,
        // hue
        hueOff: rng(),
        hueSpd: (rng() < 0.5 ? -1 : 1) * (0.004 + rng() * 0.010),
        // breathing brightness (keeps each blob constantly changing)
        briPh: rng() * Math.PI * 2,
        briSpd: 0.07 + rng() * 0.12
      });
    }
    return blobs;
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Plasma Lava Lamp",

    setup: function(ctx, w, h){
      var rng = makeRng(0x1a7a1a3);
      var minDim = Math.min(w, h);
      var area = (w > 0 && h > 0) ? w * h : 0;
      // 6-9 big blobs scaled gently by area, clamped
      var n = Math.round(6 + area * 0.0000018);
      if (n < 6) n = 6;
      if (n > 9) n = 9;

      var state = {
        rng: rng,
        blobs: makeBlobs(rng, n),
        minDim: minDim,
        baseHue: rng(),          // slowly cycling global hue
        // slow global circulation so the WHOLE field migrates (anti burn-in)
        driftPx: rng() * Math.PI * 2,
        driftPy: rng() * Math.PI * 2
      };
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0) return;
      if (!state || !state.blobs) return;
      if (!isFinite(dt) || dt < 0) dt = 0.016;

      var minDim = Math.min(w, h); // resize safety: recompute each frame

      // --- background: TRUE BLACK base, painted every frame ---
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      // very subtle, slowly-roaming dark ambient wash (never a static bright region)
      var ambHue = state.baseHue + t * 0.006;
      var amb = hsv(ambHue + 0.05, 0.7, 0.05);
      var vg = ctx.createRadialGradient(
        w * (0.5 + 0.18 * Math.sin(t * 0.043)),
        h * (0.5 + 0.16 * Math.cos(t * 0.037)),
        0,
        w * 0.5, h * 0.5, Math.max(w, h) * 0.75
      );
      vg.addColorStop(0, "rgba(" + amb[0] + "," + amb[1] + "," + amb[2] + ",0.5)");
      vg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      // --- additive blobs ---
      ctx.globalCompositeOperation = "lighter";

      var blobs = state.blobs;

      // slow whole-field circulation (a few-minute orbit) so no anchor stays put
      var gdx = 0.10 * Math.sin(t * 0.013 + state.driftPx) * w;
      var gdy = 0.10 * Math.cos(t * 0.011 + state.driftPy) * h;

      for (var i = 0; i < blobs.length; i++){
        var b = blobs[i];

        // position: two-octave sinusoidal drift around a full-frame anchor
        var ox = (b.ax1 * Math.sin(t * b.sx1 * 6.2832 + b.px1)
                + b.ax2 * Math.sin(t * b.sx2 * 6.2832 + b.px2)) * w;
        var oy = (b.ay1 * Math.cos(t * b.sy1 * 6.2832 + b.py1)
                + b.ay2 * Math.cos(t * b.sy2 * 6.2832 + b.py2)) * h;

        // anchor spread across the full frame (0.12..0.88), plus drift + global orbit
        var x = (0.12 + 0.76 * b.bx) * w + ox + gdx;
        var y = (0.12 + 0.76 * b.by) * h + oy + gdy;

        // radius pulse (gooey breathing)
        var r = (b.rBase + b.rPulse * Math.sin(t * b.rSpd * 6.2832 + b.rPh)) * minDim;
        if (r < 8) r = 8;

        // hue: global cycle + per-blob offset + slow individual drift
        var hue = state.baseHue + b.hueOff + t * b.hueSpd + t * 0.010;
        var col = hsv(hue, 0.85, 1.0);

        // brightness breathing (every blob always changing; low peak to keep avg luminance down)
        var bri = 0.34 + 0.18 * (0.5 + 0.5 * Math.sin(t * b.briSpd * 6.2832 + b.briPh));

        var rr = col[0], gg = col[1], bb = col[2];

        var g = ctx.createRadialGradient(x, y, 0, x, y, r);
        // soft gooey falloff: modest core, long smooth luminous tail
        g.addColorStop(0.0, "rgba(" + rr + "," + gg + "," + bb + "," + bri.toFixed(3) + ")");
        g.addColorStop(0.18, "rgba(" + rr + "," + gg + "," + bb + "," + (bri * 0.6).toFixed(3) + ")");
        g.addColorStop(0.45, "rgba(" + rr + "," + gg + "," + bb + "," + (bri * 0.22).toFixed(3) + ")");
        g.addColorStop(0.75, "rgba(" + rr + "," + gg + "," + bb + "," + (bri * 0.06).toFixed(3) + ")");
        g.addColorStop(1.0, "rgba(" + rr + "," + gg + "," + bb + ",0)");

        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fill();

        // small inner molten highlight (kept dim so overlaps never blow out)
        var cr = r * 0.30;
        var coreHue = hue + 0.04;
        var ccol = hsv(coreHue, 0.55, 1.0);
        var cg = ctx.createRadialGradient(x, y, 0, x, y, cr);
        cg.addColorStop(0.0, "rgba(" + ccol[0] + "," + ccol[1] + "," + ccol[2] + "," + (bri * 0.4).toFixed(3) + ")");
        cg.addColorStop(1.0, "rgba(" + ccol[0] + "," + ccol[1] + "," + ccol[2] + ",0)");
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(x, y, cr, 0, 6.2832);
        ctx.fill();
      }

      // slowly advance global hue so the whole lamp cycles color over minutes
      state.baseHue += dt * 0.004;
      if (state.baseHue > 1000) state.baseHue -= 1000;

      // reset state so we never leak into the next scene
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  });
})();