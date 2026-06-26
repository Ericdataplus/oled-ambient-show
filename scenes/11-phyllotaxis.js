(function(){
  "use strict";

  // ---- PRNG (mulberry32) ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ~137.507 deg in radians

  function hsl(h, s, l){
    // h in [0,360), s,l in [0,1] -> "rgb(...)"
    h = ((h % 360) + 360) % 360;
    if (s < 0) s = 0; else if (s > 1) s = 1;
    if (l < 0) l = 0; else if (l > 1) l = 1;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60){ r = c; g = x; }
    else if (h < 120){ r = x; g = c; }
    else if (h < 180){ g = c; b = x; }
    else if (h < 240){ g = x; b = c; }
    else if (h < 300){ r = x; b = c; }
    else { r = c; b = x; }
    return "rgb(" + ((r + m) * 255 | 0) + "," + ((g + m) * 255 | 0) + "," + ((b + m) * 255 | 0) + ")";
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Phyllotaxis Bloom",

    setup: function(ctx, w, h){
      var state = {};
      if (w <= 0 || h <= 0) return state;

      var rnd = mulberry32(0x9E3779B9 ^ ((w * 73856093) ^ (h * 19349663)));
      state.rnd = rnd;

      var dpr = ctx.oledDPR || 1;
      state.dpr = dpr;
      state.hair = 1 / dpr;

      // Count scales with area but clamped. Dense field.
      var area = w * h;
      var count = Math.floor(area / 380);
      if (count < 1400) count = 1400;
      if (count > 5200) count = 5200;
      state.count = count;

      // Spacing constant for phyllotaxis: r = c * sqrt(i)
      var minDim = Math.min(w, h);
      // base radius so outer ring reaches a healthy fraction of the panel
      state.baseC = (minDim * 0.46) / Math.sqrt(count);

      // Precompute per-dot static attributes (angle index, sqrt, jitter, twinkle phase)
      var sqrtI = new Float32Array(count);
      var ang = new Float32Array(count);
      var tw = new Float32Array(count);     // twinkle phase
      var twS = new Float32Array(count);    // twinkle speed
      var hueBase = new Float32Array(count);
      for (var i = 0; i < count; i++){
        sqrtI[i] = Math.sqrt(i + 0.5);
        ang[i] = i * GOLDEN;
        tw[i] = rnd() * Math.PI * 2;
        twS[i] = 0.4 + rnd() * 0.9;
        // hue runs along spiral index, cyclic so the gradient flows
        hueBase[i] = (i / count);
      }
      state.sqrtI = sqrtI;
      state.ang = ang;
      state.tw = tw;
      state.twS = twS;
      state.hueBase = hueBase;

      // Color cycling base
      state.hueShift = rnd() * 360;

      // Center drift (Lissajous) parameters
      state.dax = 0.013 + rnd() * 0.01;
      state.day = 0.017 + rnd() * 0.01;
      state.dpx = rnd() * Math.PI * 2;
      state.dpy = rnd() * Math.PI * 2;

      // dot sizes in device px
      state.dotMin = 1.0; // device px target for crisp pinpoints

      // glow radius scaled by device pixels so it reads correctly at high PPI
      state.glowR = 4.5 / dpr;

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0 || !state.sqrtI) return;
      if (dt > 0.1) dt = 0.1; else if (dt < 0) dt = 0;

      // background true black
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);

      var count = state.count;
      var sqrtI = state.sqrtI;
      var ang = state.ang;
      var tw = state.tw, twS = state.twS, hueBase = state.hueBase;
      var dpr = state.dpr;

      // ---- global slow rotation ----
      var rot = t * 0.045;

      // ---- breathing radius scale ----
      var breathe = 1 + 0.085 * Math.sin(t * 0.18) + 0.04 * Math.sin(t * 0.071 + 1.3);
      var c = state.baseC * breathe;

      // ---- center drift (Lissajous) so it never pins ----
      var driftR = Math.min(w, h) * 0.13;
      var cx = w * 0.5 + Math.cos(t * state.dax + state.dpx) * driftR;
      var cy = h * 0.5 + Math.sin(t * state.day + state.dpy) * driftR * 0.85;

      // hue flow along spiral + global slow rotation of palette (meditative pace)
      var hueGlobal = state.hueShift + t * 3;
      var hueSpan = 300; // degrees swept across the spiral
      var hueDrift = t * 0.02; // slowly slide the gradient along index

      var dotMin = state.dotMin;
      var maxSqrt = sqrtI[count - 1] || 1;
      var invMaxSqrt = 1 / maxSqrt;

      // smallest crisp footprint in CSS px so a dot is never sub-pixel-invisible
      // on the supersampled (~2.25x) backing buffer
      var minSizeCss = 1 / dpr;

      // most dots crisp pinpoints (source-over); brightest outer dots get glow
      ctx.globalCompositeOperation = "source-over";

      // Reuse arrays stored in state to avoid per-frame alloc
      if (!state._gx){
        var cap = 220;
        state._gx = new Float32Array(cap);
        state._gy = new Float32Array(cap);
        state._gh = new Float32Array(cap);
        state._gs = new Float32Array(cap);
        state._gcap = cap;
      }
      var gx = state._gx, gy = state._gy, gh = state._gh, gs = state._gs, gcap = state._gcap;
      var glowCount = 0;

      for (var i = 0; i < count; i++){
        var rr = c * sqrtI[i];
        var a = ang[i] + rot;
        var px = cx + Math.cos(a) * rr;
        var py = cy + Math.sin(a) * rr;

        // cull offscreen for speed
        if (px < -4 || px > w + 4 || py < -4 || py > h + 4) continue;

        var norm = sqrtI[i] * invMaxSqrt; // 0..1 inner->outer

        // twinkle
        var tk = 0.78 + 0.22 * Math.sin(t * twS[i] + tw[i]);

        // outer ring slightly brighter
        var lum = (0.30 + 0.34 * norm) * tk;
        if (lum < 0.04) lum = 0.04;
        if (lum > 0.92) lum = 0.92;

        // hue along index, drifting
        var hh = hueGlobal + (hueBase[i] + hueDrift) * hueSpan;
        var sat = 0.72 + 0.18 * norm;

        ctx.fillStyle = hsl(hh, sat, lum);

        // dot size in device px -> CSS px, outer slightly larger
        var sizeDev = dotMin + norm * 1.1;
        var size = sizeDev / dpr;
        if (size < minSizeCss) size = minSizeCss; // keep pinpoints visible & crisp
        var hs = size * 0.5;
        ctx.fillRect(px - hs, py - hs, size, size);

        // collect brightest outer dots for additive glow
        if (norm > 0.82 && tk > 0.9 && glowCount < gcap){
          gx[glowCount] = px;
          gy[glowCount] = py;
          gh[glowCount] = hh;
          gs[glowCount] = sat;
          glowCount++;
        }
      }

      // ---- additive glow pass for the few brightest outer dots ----
      if (glowCount > 0){
        var glowR = state.glowR;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5;
        for (var k = 0; k < glowCount; k++){
          var grad = ctx.createRadialGradient(gx[k], gy[k], 0, gx[k], gy[k], glowR);
          var col = hsl(gh[k], gs[k] * 0.9, 0.6);
          grad.addColorStop(0, col);
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(gx[k], gy[k], glowR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }

      // ---- soft central seed glow (small, drifts with center, dim) ----
      ctx.globalCompositeOperation = "lighter";
      var seedR = Math.min(w, h) * 0.05;
      var sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, seedR);
      var seedHue = hueGlobal + 20;
      sg.addColorStop(0, hsl(seedHue, 0.6, 0.26));
      sg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = sg;
      ctx.globalAlpha = 0.28 + 0.07 * Math.sin(t * 0.13);
      ctx.beginPath();
      ctx.arc(cx, cy, seedR, 0, Math.PI * 2);
      ctx.fill();

      // reset context for next scene
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1;
    }
  });
})();