(function(){
  "use strict";

  // ---- helpers (all inside IIFE) ----
  function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

  // small fast hash -> [0,1)
  function hash(x){
    x = (x ^ 61) ^ (x >>> 16);
    x = x + (x << 3);
    x = x ^ (x >>> 4);
    x = Math.imul(x, 0x27d4eb2d);
    x = x ^ (x >>> 15);
    return ((x >>> 0) % 100000) / 100000;
  }

  // 1D value noise (smooth) for curtain undulation
  function vnoise(x){
    var i = Math.floor(x);
    var f = x - i;
    var u = f * f * (3 - 2 * f);
    var a = hash(i & 0x7fffffff);
    var b = hash((i + 1) & 0x7fffffff);
    return a + (b - a) * u; // [0,1)
  }

  // HSV-ish (h in [0,1)) -> rgb components, returns [r,g,b]
  function hsv(h, s, v){
    h = (h % 1 + 1) % 1;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    var r, g, b;
    switch(i % 6){
      case 0: r=v; g=t; b=p; break;
      case 1: r=q; g=v; b=p; break;
      case 2: r=p; g=v; b=t; break;
      case 3: r=p; g=q; b=v; break;
      case 4: r=t; g=p; b=v; break;
      default: r=v; g=p; b=q; break;
    }
    return [ (r*255)|0, (g*255)|0, (b*255)|0 ];
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Aurora Borealis",

    setup: function(ctx, w, h){
      var state = {};

      // ---- stars (persistent positions; only twinkle in draw) ----
      var starCount = clamp(Math.floor(w * h * 0.00012), 60, 260);
      var stars = [];
      for (var i = 0; i < starCount; i++){
        stars.push({
          x: hash(i*2+1) * w,
          y: hash(i*7+3) * h * 0.92,
          r: 0.4 + hash(i*13+5) * 1.1,
          base: 0.25 + hash(i*17+9) * 0.5,
          tw: 0.4 + hash(i*23+11) * 1.6,   // twinkle speed
          ph: hash(i*29+2) * 6.283         // phase
        });
      }
      state.stars = stars;

      // ---- aurora curtains ----
      // Each curtain is a vertical band sampled horizontally across width.
      var curtainCount = clamp(Math.floor(w * 0.012), 4, 8);
      var curtains = [];
      for (var c = 0; c < curtainCount; c++){
        var r = hash(c*101 + 7);
        var r2 = hash(c*211 + 13);
        var r3 = hash(c*307 + 21);
        curtains.push({
          hueOff: (c / curtainCount) * 0.18 + r * 0.06,  // hue spread between curtains
          drift: 0.012 + r * 0.02,        // horizontal drift speed
          driftPh: r2 * 100,
          // wave params (layered sines + noise)
          a1: 0.10 + r * 0.06,   f1: 1.3 + r2 * 1.4,  s1: 0.06 + r3 * 0.05,
          a2: 0.05 + r2 * 0.05,  f2: 2.6 + r3 * 2.0,  s2: 0.10 + r * 0.06,
          nScale: 1.4 + r * 1.6,         // noise spatial scale
          nSpeed: 0.03 + r2 * 0.05,      // noise temporal scale
          topFrac: 0.02 + r3 * 0.10,     // where the curtain top sits
          height: 0.55 + r * 0.30,       // fraction of height the curtain spans
          width: 26 + r2 * 34,           // glow stroke width in px
          intensity: 0.45 + r3 * 0.45,
          seedShift: c * 53.13
        });
      }
      state.curtains = curtains;

      // horizontal sampling resolution (segments along width); capped for perf
      state.cols = clamp(Math.floor(w / 16), 36, 110);

      // global hue cycle anchor
      state.hueBase = hash(123) * 1.0;

      state.w = w; state.h = h;
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0) return;

      // ---- background: true black with gentle trail for silky motion ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(0, 0, w, h);
      // trail self-decays toward true black; no buildup

      // ---- stars (additive, faint, twinkling) ----
      ctx.globalCompositeOperation = "lighter";
      var stars = state.stars;
      for (var si = 0; si < stars.length; si++){
        var s = stars[si];
        var tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph);
        var a = s.base * tw * 0.7;
        if (a <= 0.01) continue;
        ctx.globalAlpha = a;
        ctx.fillStyle = "#cfe6ff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ---- slow global hue cycle: green -> teal -> violet -> rose ----
      var cyc = (t * 0.012 + state.hueBase) % 1;       // very slow
      // base hue oscillates around the aurora palette
      var paletteHue = 0.33 + 0.30 * Math.sin(cyc * 6.2832) + 0.18 * Math.sin(cyc * 12.566 + 1.3);

      var cols = state.cols;
      var curtains = state.curtains;

      for (var ci = 0; ci < curtains.length; ci++){
        var cu = curtains[ci];

        var drift = (t * cu.drift + cu.driftPh);
        var topY = h * cu.topFrac;
        var spanH = h * cu.height;

        // hue for this curtain
        var hue = paletteHue + cu.hueOff + 0.04 * Math.sin(t * 0.05 + cu.seedShift);
        var rgb = hsv(hue, 0.85, 1.0);
        var rr = rgb[0], gg = rgb[1], bb = rgb[2];

        // overall slow breathing intensity (no strobe)
        var breathe = 0.6 + 0.4 * Math.sin(t * 0.06 + ci * 1.7);
        var baseAlpha = cu.intensity * breathe;

        // draw as soft vertical gradient strokes following a waving x(t,col)
        for (var col = 0; col <= cols; col++){
          var u = col / cols;                 // 0..1 across width
          var px = u * w;

          // horizontal wave displacement (layered sine + value noise)
          var phase = u * 6.2832;
          var wave =
            cu.a1 * Math.sin(phase * cu.f1 + t * cu.s1 + drift) +
            cu.a2 * Math.sin(phase * cu.f2 - t * cu.s2 + drift * 1.7);
          var n = vnoise(u * cu.nScale * cols * 0.12 + t * cu.nSpeed * 10 + cu.seedShift) - 0.5;
          var xoff = (wave + n * 0.10) * w * 0.10;
          var cx = px + xoff;

          // per-column vertical extent shimmer (curtains shift up/down a touch)
          var topShimmer = topY + Math.sin(phase * 1.7 + t * 0.07 + cu.seedShift) * h * 0.025;
          var thisSpan = spanH * (0.85 + 0.15 * vnoise(u * 3.1 + t * 0.05 + ci * 9.0));

          // per-column brightness variation (vertical "rays")
          var ray = 0.45 + 0.55 * vnoise(u * cu.nScale * 4.0 + t * cu.nSpeed * 6 + cu.seedShift * 2.0);
          var aCol = baseAlpha * ray;
          if (aCol <= 0.015) continue;

          var y0 = topShimmer;
          var y1 = topShimmer + thisSpan;

          var grad = ctx.createLinearGradient(0, y0, 0, y1);
          // bright near top, fading down (top-to-bottom fade)
          grad.addColorStop(0.0,  "rgba(" + rr + "," + gg + "," + bb + ",0)");
          grad.addColorStop(0.12, "rgba(" + rr + "," + gg + "," + bb + "," + (aCol * 0.9).toFixed(3) + ")");
          grad.addColorStop(0.45, "rgba(" + rr + "," + gg + "," + bb + "," + (aCol * 0.5).toFixed(3) + ")");
          grad.addColorStop(1.0,  "rgba(" + rr + "," + gg + "," + bb + ",0)");

          ctx.strokeStyle = grad;
          ctx.lineWidth = cu.width;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(cx, y0);
          ctx.lineTo(cx, y1);
          ctx.stroke();
        }
      }

      // ---- soft low glow bloom for depth (drifts in BOTH axes; never static) ----
      var glowHue = paletteHue + 0.05;
      var grgb = hsv(glowHue, 0.7, 1.0);
      var gx = w * (0.5 + 0.25 * Math.sin(t * 0.02));
      var gy = h * (0.30 + 0.06 * Math.sin(t * 0.013 + 1.1)); // slow vertical wander (burn-in insurance)
      var gr = Math.max(w, h) * 0.55;
      var bg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      var ga = 0.06 + 0.03 * Math.sin(t * 0.05);
      bg.addColorStop(0, "rgba(" + grgb[0] + "," + grgb[1] + "," + grgb[2] + "," + ga.toFixed(3) + ")");
      bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // ---- reset all canvas state ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineCap = "butt";
    }
  });
})();