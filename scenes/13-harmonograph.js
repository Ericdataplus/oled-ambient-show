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

  // hsl -> rgb (0..1 in, 0..255 out)
  function hsl2rgb(h, s, l){
    h = ((h % 1) + 1) % 1;
    if (s < 0) s = 0; else if (s > 1) s = 1;
    if (l < 0) l = 0; else if (l > 1) l = 1;
    var r, g, b;
    if (s === 0){ r = g = b = l; }
    else {
      var hue2 = function(p, q, t){
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2(p, q, h + 1/3);
      g = hue2(p, q, h);
      b = hue2(p, q, h - 1/3);
    }
    return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
  }

  function smoothstep(x){
    if (x < 0) x = 0; else if (x > 1) x = 1;
    return x * x * (3 - 2 * x);
  }

  // A damped harmonograph: 4 pendulums, 2 per axis.
  //   x(p) = sum Ai * sin(fi*p + phi_i) * exp(-di*p)
  // Traced by "phase" p (proportional to time) so the figure is reproducible.

  function makeFigure(rng){
    // frequencies near small integer ratios for pleasing Lissajous lock,
    // with tiny detuning so the curve precesses (never freezes).
    var baseFreqs = [
      2 + Math.floor(rng()*3),   // 2..4
      2 + Math.floor(rng()*3),
      2 + Math.floor(rng()*3),
      2 + Math.floor(rng()*3)
    ];
    var detune = function(){ return (rng()-0.5) * 0.012; };
    return {
      // x-axis pendulums (0,1), y-axis pendulums (2,3)
      f: [
        baseFreqs[0] + detune(),
        baseFreqs[1] + detune(),
        baseFreqs[2] + detune(),
        baseFreqs[3] + detune()
      ],
      ph: [ rng()*Math.PI*2, rng()*Math.PI*2, rng()*Math.PI*2, rng()*Math.PI*2 ],
      amp: [
        0.55 + rng()*0.45,
        0.30 + rng()*0.30,
        0.55 + rng()*0.45,
        0.30 + rng()*0.30
      ],
      // very light damping so the figure narrows gently across a draw pass
      damp: [
        0.0012 + rng()*0.0020,
        0.0012 + rng()*0.0020,
        0.0012 + rng()*0.0020,
        0.0012 + rng()*0.0020
      ],
      hue: rng()
    };
  }

  // Lerp figure params into a reused scratch object (no per-frame allocation).
  function lerpFig(a, b, k, out){
    for (var i=0;i<4;i++){
      out.f[i]    = a.f[i]    + (b.f[i]    - a.f[i])    * k;
      // phases: take the shortest way around the circle
      var dp = ((b.ph[i] - a.ph[i] + Math.PI) % (Math.PI*2)) - Math.PI;
      out.ph[i]   = a.ph[i] + dp * k;
      out.amp[i]  = a.amp[i]  + (b.amp[i]  - a.amp[i])  * k;
      out.damp[i] = a.damp[i] + (b.damp[i] - a.damp[i]) * k;
    }
    // hue lerp the shortest way around the wheel
    var dh = ((((b.hue - a.hue) % 1) + 1.5) % 1) - 0.5;
    out.hue = a.hue + dh * k;
    return out;
  }

  function evalX(fig, p){
    return fig.amp[0]*Math.sin(fig.f[0]*p + fig.ph[0])*Math.exp(-fig.damp[0]*p)
         + fig.amp[1]*Math.sin(fig.f[1]*p + fig.ph[1])*Math.exp(-fig.damp[1]*p);
  }
  function evalY(fig, p){
    return fig.amp[2]*Math.sin(fig.f[2]*p + fig.ph[2])*Math.exp(-fig.damp[2]*p)
         + fig.amp[3]*Math.sin(fig.f[3]*p + fig.ph[3])*Math.exp(-fig.damp[3]*p);
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Harmonograph",

    setup: function(ctx, w, h){
      if (w <= 0 || h <= 0) return {};
      var seed = (Math.floor(Math.random()*0x7fffffff)) >>> 0;
      var rng = mulberry32(seed);

      var state = {
        rng: rng,
        figA: null,
        figB: null,
        // scratch figure reused every frame (no per-frame allocation)
        figC: { f:[0,0,0,0], ph:[0,0,0,0], amp:[0,0,0,0], damp:[0,0,0,0], hue:0 },
        cycle: 46,          // seconds for one figure life
        morphT: 0.20,       // fraction of cycle spent morphing params at the tail
        phaseSpeed: 5.6,    // radians of phase per second of drawing
        // composition drift
        driftSeed1: rng()*1000,
        driftSeed2: rng()*1000,
        hueDrift: rng(),
        scaleBase: Math.min(w, h) * 0.34,
        cycleIndex: -1
      };
      state.figA = makeFigure(rng);
      state.figB = makeFigure(rng);
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0 || !state || !state.figA) return;
      if (!(dt > 0) || dt > 0.05) dt = 0.016; // clamp spikes / bad values

      var oledDPR = ctx.oledDPR;
      var hair = (oledDPR && oledDPR > 0) ? (1 / oledDPR) : 0.6; // ~1 device-px hairline

      // --- long fading trails: low-alpha black wash each frame (keeps avg luminance low) ---
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.05)";
      ctx.fillRect(0, 0, w, h);

      // --- cycle / morph bookkeeping ---
      var cycle = state.cycle;
      var local = t % cycle;
      var ci = Math.floor(t / cycle);
      if (ci !== state.cycleIndex){
        if (state.cycleIndex !== -1){
          // advanced into a new figure: B becomes A, make a fresh B
          state.figA = state.figB;
          state.figB = makeFigure(state.rng);
        }
        state.cycleIndex = ci;
      }

      // morph fraction: hold figA most of the cycle, then ease toward figB at the tail
      var morphStart = cycle * (1 - state.morphT);
      var k = 0;
      if (local > morphStart){
        k = smoothstep((local - morphStart) / (cycle - morphStart));
      }
      var fig = lerpFig(state.figA, state.figB, k, state.figC);

      // --- advance phase directly from time; draw the arc swept since last frame ---
      var pNow  = local * state.phaseSpeed;
      var pPrev = (local - dt) * state.phaseSpeed;
      if (pPrev < 0) pPrev = 0;

      // whole-figure life envelope: fade in, full, dissolve (no hard jumps)
      var lifeK = local / cycle;
      var envelope;
      if (lifeK < 0.06) envelope = lifeK / 0.06;            // fade in
      else if (lifeK > 0.80) envelope = (1 - lifeK) / 0.20; // dissolve
      else envelope = 1;
      envelope = smoothstep(envelope);

      // --- composition drift (center never pins) ---
      var cx = w * 0.5
        + Math.sin(t * 0.021 + state.driftSeed1) * w * 0.07
        + Math.cos(t * 0.013 + state.driftSeed2) * w * 0.04;
      var cy = h * 0.5
        + Math.cos(t * 0.018 + state.driftSeed2) * h * 0.07
        + Math.sin(t * 0.011 + state.driftSeed1) * h * 0.04;

      // slow whole-figure rotation so anchors never freeze
      var rot = t * 0.018 + Math.sin(t * 0.007) * 0.25;
      var cr = Math.cos(rot), sr = Math.sin(rot);

      var scale = state.scaleBase * (0.92 + 0.08 * Math.sin(t * 0.04));

      // slowly shifting jewel hue
      var hue = (fig.hue + state.hueDrift + t * 0.0065) % 1;

      // --- draw short hairline segments between pPrev and pNow (additive on black) ---
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      var span = pNow - pPrev;
      if (span <= 0) span = 0.0001;
      // segment count proportional to phase advanced; cap for safety
      var segs = Math.ceil(span * 26);
      if (segs < 8) segs = 8;
      else if (segs > 220) segs = 220;

      var x0 = evalX(fig, pPrev), y0 = evalY(fig, pPrev);
      var px = cx + (x0 * cr - y0 * sr) * scale;
      var py = cy + (x0 * sr + y0 * cr) * scale;

      // Main filigree pass (uniform faint hairline)
      var i, fr, p, xx, yy, sx = px, sy = py;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (i = 1; i <= segs; i++){
        fr = i / segs;
        p = pPrev + span * fr;
        xx = evalX(fig, p);
        yy = evalY(fig, p);
        sx = cx + (xx * cr - yy * sr) * scale;
        sy = cy + (xx * sr + yy * cr) * scale;
        ctx.lineTo(sx, sy);
      }
      var rgb = hsl2rgb(hue, 0.85, 0.55);
      ctx.strokeStyle = "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ","
        + (0.55 * envelope).toFixed(3) + ")";
      ctx.lineWidth = hair;
      ctx.stroke();

      // Bright luminous leading tip (the active "pen"): a short brighter overdraw
      var tipSegs = segs < 60 ? segs : 60;
      var tipStartFr = 1 - tipSegs / segs;
      var ptip0 = pPrev + span * tipStartFr;
      var tx0 = evalX(fig, ptip0), ty0 = evalY(fig, ptip0);
      ctx.beginPath();
      ctx.moveTo(cx + (tx0*cr - ty0*sr)*scale, cy + (tx0*sr + ty0*cr)*scale);
      for (i = 1; i <= tipSegs; i++){
        fr = tipStartFr + (1 - tipStartFr) * (i / tipSegs);
        p = pPrev + span * fr;
        xx = evalX(fig, p);
        yy = evalY(fig, p);
        sx = cx + (xx * cr - yy * sr) * scale;
        sy = cy + (xx * sr + yy * cr) * scale;
        ctx.lineTo(sx, sy);
      }
      var rgb2 = hsl2rgb((hue + 0.04), 0.7, 0.72);
      ctx.strokeStyle = "rgba(" + rgb2[0] + "," + rgb2[1] + "," + rgb2[2] + ","
        + (0.9 * envelope).toFixed(3) + ")";
      ctx.lineWidth = hair * 1.4;
      ctx.stroke();

      // Pin-sharp glowing pen head — the ONLY soft glow, and it moves every frame
      var hr = hsl2rgb((hue + 0.02), 0.6, 0.85);
      ctx.fillStyle = "rgba(" + hr[0] + "," + hr[1] + "," + hr[2] + ","
        + (0.95 * envelope).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(sx, sy, hair * 1.6, 0, Math.PI * 2);
      ctx.fill();
      // faint halo (reserved soft glow for the single brightest point)
      ctx.fillStyle = "rgba(" + hr[0] + "," + hr[1] + "," + hr[2] + ","
        + (0.22 * envelope).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(sx, sy, hair * 4.0, 0, Math.PI * 2);
      ctx.fill();

      // --- reset context state for the next scene ---
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
    }
  });
})();