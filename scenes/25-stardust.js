(function(){
  "use strict";

  // ---- PRNG (mulberry32) ----
  function makePRNG(seed){
    var s = seed >>> 0;
    return function(){
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

  // Cool-to-warm star color: mostly blue-white, some warm, restrained.
  function starColor(tw){
    var r, g, b;
    if (tw < 0.80){
      var k = tw / 0.80;        // 0..1
      r = 178 + k * 66;         // 178..244
      g = 202 + k * 46;         // 202..248
      b = 255;                  // blue-white
    } else {
      var k2 = (tw - 0.80) / 0.20; // 0..1
      r = 255;
      g = 224 - k2 * 70;        // 224..154
      b = 205 - k2 * 110;       // 205..95
    }
    return [Math.round(r), Math.round(g), Math.round(b)];
  }

  function buildStars(rng, count, w, h, depth, margin){
    var arr = new Array(count);
    for (var i = 0; i < count; i++){
      var u = rng();
      var mag = Math.pow(u, 3.0);            // skew faint (lots faint, few bright)
      var size = 0.45 + mag * 1.85;          // device-px multiplier
      var spike = (mag > 0.88 && rng() < 0.45);
      var col = starColor(rng());
      arr[i] = {
        x: rng() * (w + margin * 2) - margin,
        y: rng() * (h + margin * 2) - margin,
        size: size,
        bright: 0.18 + mag * 0.78,
        col: col,
        spike: spike,
        twPhase: rng() * Math.PI * 2,
        twSpeed: 0.15 + rng() * 0.5,
        twAmt: 0.07 + rng() * 0.20
      };
    }
    return { stars: arr, depth: depth, margin: margin };
  }

  function buildDust(rng, count, w, h){
    var arr = new Array(count);
    var palette = [
      [60, 110, 150],   // dusty blue
      [50, 130, 130],   // teal
      [70, 95, 160],    // indigo-blue
      [40, 120, 140],   // cool teal
      [150, 95, 70]     // rare warm
    ];
    for (var i = 0; i < count; i++){
      var warm = rng() < 0.14;
      var col = warm ? palette[4] : palette[(rng() * 4) | 0];
      var r = (Math.min(w, h) * (0.28 + rng() * 0.55));
      arr[i] = {
        x: rng() * (w * 1.4) - w * 0.2,
        y: rng() * (h * 1.4) - h * 0.2,
        r: r,
        col: col,
        alpha: 0.013 + rng() * 0.026,      // very low (restrained, dusty)
        depth: 0.10 + rng() * 0.35,
        pulPhase: rng() * Math.PI * 2,
        pulSpeed: 0.04 + rng() * 0.08,
        pulAmt: 0.22 + rng() * 0.30
      };
    }
    return arr;
  }

  function buildMotes(rng, count, w, h){
    var arr = new Array(count);
    for (var i = 0; i < count; i++){
      arr[i] = {
        x: rng() * w,
        y: rng() * h,
        size: 0.3 + rng() * 0.4,
        bright: 0.05 + rng() * 0.12,
        depth: 0.04 + rng() * 0.08,
        twPhase: rng() * Math.PI * 2,
        twSpeed: 0.2 + rng() * 0.4
      };
    }
    return arr;
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Stardust Drift",

    setup: function(ctx, w, h){
      var state = {};
      if (w <= 0 || h <= 0){ state.empty = true; return state; }
      state.empty = false;

      var rng = makePRNG((0x5743D2 ^ ((w * 73856093) ^ (h * 19349663))) >>> 0);
      state.rng = rng;

      var area = w * h;
      var scale = clamp(area / (1920 * 1080), 0.35, 2.4);

      var margin = Math.max(w, h) * 0.15;
      state.layers = [
        buildStars(rng, Math.round(900 * scale), w, h, 0.06, margin),  // far
        buildStars(rng, Math.round(520 * scale), w, h, 0.16, margin),  // mid
        buildStars(rng, Math.round(240 * scale), w, h, 0.34, margin)   // near
      ];

      state.dust = buildDust(rng, Math.round(7 + 5 * scale), w, h);
      state.motes = buildMotes(rng, Math.round(60 * scale), w, h);

      state.margin = margin;
      state.w = w; state.h = h;

      // Drift accumulators (integrated from dt -> precision-safe over hours).
      // We accumulate a base offset and wrap it; layers/dust/motes scale by depth.
      state.offX = 0;
      state.offY = 0;
      state.driftPhase = rng() * Math.PI * 2;   // seed angle wander phase
      state.baseSpeed = Math.max(w, h) * 0.0075; // px/sec base drift magnitude
      // bound for offset wrap (large vs any span so per-element wrap is exact)
      state.wrapSpan = Math.max(w, h) * 8 + margin * 4;

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (!state || state.empty || w <= 0 || h <= 0) {
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, Math.max(0,w), Math.max(0,h));
        return;
      }
      if (!(dt > 0)) dt = 0;
      if (dt > 0.05) dt = 0.05;

      var dpr = ctx.oledDPR || 1;
      var devUnit = 1 / (dpr || 1.6667);      // one device pixel in CSS px
      var px = devUnit;
      if (!isFinite(px) || px <= 0) px = 0.6;

      // True black background every frame.
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);

      var margin = state.margin;

      // ---- DRIFT: slowly wandering DIRECTION, but speed never drops to zero,
      // and the offset is INTEGRATED from dt (bounded, hour-safe). The field
      // therefore moves continuously and nothing pins. ----
      var ang = state.driftPhase
              + Math.sin(t * 0.017) * 0.7
              + Math.cos(t * 0.0091) * 0.5;
      // keep a continuous baseline so cos/sin crossing zero can't stall a axis
      var sp = state.baseSpeed;
      var vx = (Math.cos(ang) * 0.85 + 0.25) * sp;       // always nonzero-ish
      var vy = (Math.sin(ang) * 0.85 + 0.15) * sp * 0.6; // flatter vertical

      state.offX += vx * dt;
      state.offY += vy * dt;
      var wrap = state.wrapSpan;
      if (state.offX > wrap || state.offX < -wrap) state.offX = state.offX % wrap;
      if (state.offY > wrap || state.offY < -wrap) state.offY = state.offY % wrap;

      var baseOffX = state.offX;
      var baseOffY = state.offY;

      // ---- DUST CLOUDS (far/mid, additive, very low alpha) ----
      ctx.globalCompositeOperation = "lighter";
      var dust = state.dust;
      for (var d = 0; d < dust.length; d++){
        var cl = dust[d];
        var dsp = cl.depth;
        var spanX = w + cl.r * 2;
        var spanY = h + cl.r * 2;
        var rawX = cl.x - baseOffX * dsp;
        var rawY = cl.y - baseOffY * dsp;
        var cx = ((rawX % spanX) + spanX) % spanX - cl.r;
        var cy = ((rawY % spanY) + spanY) % spanY - cl.r;

        var pul = 1 + Math.sin(t * cl.pulSpeed + cl.pulPhase) * cl.pulAmt;
        var a = cl.alpha * pul;
        if (a <= 0.001) continue;

        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cl.r);
        var c = cl.col;
        g.addColorStop(0,   "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(4) + ")");
        g.addColorStop(0.5, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a * 0.45).toFixed(4) + ")");
        g.addColorStop(1,   "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - cl.r, cy - cl.r, cl.r * 2, cl.r * 2);
      }
      ctx.globalCompositeOperation = "source-over";

      // ---- DISTANT MOTES (very slow, faint) ----
      ctx.globalCompositeOperation = "lighter";
      var motes = state.motes;
      for (var m = 0; m < motes.length; m++){
        var mo = motes[m];
        var msp = mo.depth;
        var mx = ((mo.x - baseOffX * msp) % w + w) % w;
        var my = ((mo.y - baseOffY * msp) % h + h) % h;
        var mtw = 0.7 + 0.3 * Math.sin(t * mo.twSpeed + mo.twPhase);
        var ma = mo.bright * mtw;
        ctx.fillStyle = "rgba(200,215,255," + ma.toFixed(4) + ")";
        var ms = mo.size; // ~device-px units below
        var mrad = Math.max(ms * devUnit * (dpr || 1.6667) * 0.5, px * 0.6);
        ctx.beginPath();
        ctx.arc(mx, my, mrad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      // ---- STAR LAYERS (parallax, crisp pinpoints) ----
      var span2X = w + margin * 2;
      var span2Y = h + margin * 2;

      for (var L = 0; L < state.layers.length; L++){
        var layer = state.layers[L];
        var stars = layer.stars;
        var ld = layer.depth;
        var loX = -baseOffX * ld;
        var loY = -baseOffY * ld;

        for (var i = 0; i < stars.length; i++){
          var s = stars[i];
          var sx = ((s.x + loX + margin) % span2X + span2X) % span2X - margin;
          var sy = ((s.y + loY + margin) % span2Y + span2Y) % span2Y - margin;

          if (sx < -2 || sx > w + 2 || sy < -2 || sy > h + 2) continue;

          var tw = 1 + Math.sin(t * s.twSpeed + s.twPhase) * s.twAmt;
          var a = clamp(s.bright * tw, 0, 1);
          var c = s.col;
          var rad = s.size * devUnit * (dpr || 1.6667) * 0.55;
          if (rad < px * 0.55) rad = px * 0.55;

          // soft halo for brighter stars (additive)
          if (s.bright > 0.55){
            ctx.globalCompositeOperation = "lighter";
            var hr = rad * 4.5;
            var hg = ctx.createRadialGradient(sx, sy, 0, sx, sy, hr);
            var ha = a * 0.28;
            hg.addColorStop(0, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + ha.toFixed(4) + ")");
            hg.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
            ctx.fillStyle = hg;
            ctx.fillRect(sx - hr, sy - hr, hr * 2, hr * 2);
            ctx.globalCompositeOperation = "source-over";
          }

          // crisp core
          ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(4) + ")";
          ctx.beginPath();
          ctx.arc(sx, sy, rad, 0, Math.PI * 2);
          ctx.fill();

          // rare diffraction spikes (additive, subtle)
          if (s.spike){
            ctx.globalCompositeOperation = "lighter";
            var spLen = rad * 9;
            var spA = a * 0.20;
            ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + spA.toFixed(4) + ")";
            ctx.lineWidth = px;
            ctx.beginPath();
            ctx.moveTo(sx - spLen, sy); ctx.lineTo(sx + spLen, sy);
            ctx.moveTo(sx, sy - spLen); ctx.lineTo(sx, sy + spLen);
            ctx.stroke();
            ctx.globalCompositeOperation = "source-over";
          }
        }
      }

      // ---- cleanup: leave ctx clean for the next scene ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
  });
})();