(function(){
  "use strict";

  // ---- helpers (all internal, no globals) ----
  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

  // hsl-ish to rgb, hue in [0,1), s,l in [0,1]
  function hue2rgb(p, q, tt){
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1/6) return p + (q - p) * 6 * tt;
    if (tt < 1/2) return q;
    if (tt < 2/3) return p + (q - p) * (2/3 - tt) * 6;
    return p;
  }
  function hsl(h, s, l){
    h = h - Math.floor(h);
    var r, g, b;
    if (s === 0){ r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return [ (r*255)|0, (g*255)|0, (b*255)|0 ];
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Silk Waves",

    setup: function(ctx, w, h){
      var state = {};

      // robust against degenerate sizes; draw() guards on state.ribbons
      if (w <= 0 || h <= 0){ state.ribbons = null; return state; }

      // number of ribbons scales gently with height
      var n = Math.round(clamp(h * 0.05, 14, 36));
      state.n = n;

      // horizontal sample resolution (cap for perf)
      var seg = Math.round(clamp(w * 0.012, 48, 150));
      state.seg = seg;

      // per-ribbon parameters, persisted so nothing flickers
      var ribbons = new Array(n);
      for (var i = 0; i < n; i++){
        var u = (n > 1) ? (i / (n - 1)) : 0.5;
        ribbons[i] = {
          baseY: u,                                  // 0..1 vertical home
          // slow vertical wander of the home line -> bright crests never
          // sit in the same horizontal band for hours (burn-in safety)
          driftAmp: 0.04 + Math.random() * 0.05,     // fraction of h
          driftSpd: 0.012 + Math.random() * 0.02,    // very slow
          driftPh: Math.random() * Math.PI * 2,
          phase: Math.random() * Math.PI * 2,        // travelling-wave phase
          phaseSpd: 0.18 + Math.random() * 0.22,     // phase drift speed
          freq: 1.0 + Math.random() * 2.2,           // sine cycles across width
          freqDrift: 0.05 + Math.random() * 0.12,
          amp: 0.04 + Math.random() * 0.07,          // amplitude as fraction of h
          ampDrift: 0.07 + Math.random() * 0.13,
          ampPhase: Math.random() * Math.PI * 2,
          // secondary modulating wave for organic silk
          freq2: 0.4 + Math.random() * 1.1,
          phase2: Math.random() * Math.PI * 2,
          phase2Spd: 0.09 + Math.random() * 0.16,
          hueOff: u * 0.55 + Math.random() * 0.05,   // spread across spectrum
          breath: 0.7 + Math.random() * 0.6,         // brightness breathing rate
          breathPh: Math.random() * Math.PI * 2
        };
      }
      state.ribbons = ribbons;

      // reusable point buffers (no per-frame allocation)
      state.xs = new Float32Array(seg + 1);
      state.ys = new Float32Array(seg + 1);
      for (var k = 0; k <= seg; k++){
        state.xs[k] = (k / seg) * w;
      }

      state.hueBase = Math.random();
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0) return;
      if (!state || !state.ribbons) return;

      // gentle trail for silky persistence (mostly true black, clears fast)
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(0, 0, w, h);

      var ribbons = state.ribbons;
      var n = state.n;
      var seg = state.seg;
      var xs = state.xs;
      var ys = state.ys;

      // slow global hue sweep across the spectrum
      var globalHue = state.hueBase + t * 0.012;

      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      var TWO_PI = Math.PI * 2;

      for (var i = 0; i < n; i++){
        var r = ribbons[i];

        // slowly varying parameters
        var ph = r.phase + t * r.phaseSpd;
        var ph2 = r.phase2 + t * r.phase2Spd;
        var freq = r.freq + Math.sin(t * r.freqDrift + i) * 0.5;
        var amp = (r.amp + Math.sin(t * r.ampDrift + r.ampPhase) * r.amp * 0.45) * h;

        // wandering vertical home (kept off the very edges)
        var center = r.baseY + Math.sin(t * r.driftSpd + r.driftPh) * r.driftAmp;
        var homeY = clamp(center, 0.04, 0.96) * (h - 2) + 1;

        // build the ribbon path points (reused buffer, no allocation)
        for (var k = 0; k <= seg; k++){
          var fx = k / seg;            // 0..1 across width
          // primary travelling sine + secondary modulation = silk
          var a = Math.sin(fx * TWO_PI * freq + ph);
          var b = Math.sin(fx * TWO_PI * r.freq2 + ph2);
          ys[k] = homeY + a * amp + b * amp * 0.35;
        }

        // breathing brightness, never strobing (slow sine, low base)
        var breath = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * r.breath + r.breathPh));

        // hue varies across the ribbon and over time
        var hueA = globalHue + r.hueOff;

        // ---- soft glow underlay (wide, dim) ----
        var col1 = hsl(hueA, 0.85, 0.45);
        ctx.strokeStyle = "rgba(" + col1[0] + "," + col1[1] + "," + col1[2] + "," + (0.10 * breath).toFixed(3) + ")";
        ctx.lineWidth = clamp(h * 0.018, 6, 22);
        ctx.beginPath();
        ctx.moveTo(xs[0], ys[0]);
        for (var g = 1; g <= seg; g++){ ctx.lineTo(xs[g], ys[g]); }
        ctx.stroke();

        // ---- mid glow ----
        var col2 = hsl(hueA + 0.03, 0.9, 0.6);
        ctx.strokeStyle = "rgba(" + col2[0] + "," + col2[1] + "," + col2[2] + "," + (0.22 * breath).toFixed(3) + ")";
        ctx.lineWidth = clamp(h * 0.006, 2.5, 8);
        ctx.beginPath();
        ctx.moveTo(xs[0], ys[0]);
        for (var g2 = 1; g2 <= seg; g2++){ ctx.lineTo(xs[g2], ys[g2]); }
        ctx.stroke();

        // ---- thin bright crest (hue shifted toward white-hot) ----
        var col3 = hsl(hueA + 0.06, 0.65, 0.82);
        ctx.strokeStyle = "rgba(" + col3[0] + "," + col3[1] + "," + col3[2] + "," + (0.55 * breath).toFixed(3) + ")";
        ctx.lineWidth = clamp(h * 0.0016, 1, 2.2);
        ctx.beginPath();
        ctx.moveTo(xs[0], ys[0]);
        for (var g3 = 1; g3 <= seg; g3++){ ctx.lineTo(xs[g3], ys[g3]); }
        ctx.stroke();
      }

      // reset state so the next scene starts clean
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  });
})();