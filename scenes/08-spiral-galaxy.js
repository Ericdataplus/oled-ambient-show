(function(){
  "use strict";

  // ---- tiny seeded RNG (mulberry32) ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // gaussian-ish scatter via three uniforms (mean 0)
  function gauss(rnd){ return (rnd() + rnd() + rnd() - 1.5) * 0.9; }

  function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Spiral Galaxy",

    setup: function(ctx, w, h){
      var state = { P: [], S: [] };
      if (w <= 0 || h <= 0) return state;

      var rnd = mulberry32(0xC0FFEE ^ ((w * 131) ^ (h * 977)));
      state.rnd = rnd;

      var minDim = Math.min(w, h);
      var R = minDim * 0.46;
      state.R = R;

      // particle count scaled by area, clamped
      var n = Math.floor(w * h * 0.00042);
      n = clamp(n, 360, 1100) | 0;
      state.n = n;

      var arms = 2 + (rnd() < 0.5 ? 0 : 1); // 2 or 3 arms
      state.arms = arms;

      // logarithmic spiral tightness
      var b = 0.30 + rnd() * 0.06;
      state.b = b;

      // base rotation direction
      state.dir = rnd() < 0.5 ? 1 : -1;

      // ---- precompute particles in galaxy-local polar form ----
      var P = new Array(n);
      for (var i = 0; i < n; i++){
        // distribute radius with bias toward center (dense core)
        var u = rnd();
        var rNorm = Math.pow(u, 1.7);
        // assign to an arm
        var arm = Math.floor(rnd() * arms);
        var armBase = (arm / arms) * Math.PI * 2;

        // spiral angle from log spiral
        var rr = clamp(rNorm, 0.02, 1.0);
        var spiralTheta = armBase + Math.log(rr * 8 + 1) / b;

        // angular scatter, tighter near center, looser outside
        var scatterAng = gauss(rnd) * (0.16 + rNorm * 0.42);
        var scatterRad = gauss(rnd) * (0.015 + rNorm * 0.05);

        var theta0 = spiralTheta + scatterAng;
        var r0 = clamp(rNorm + scatterRad, 0.0, 1.05);

        // some particles are "core haze" — pulled tight to center, no arm
        if (rnd() < 0.18){
          r0 = Math.pow(rnd(), 2.4) * 0.28;
          theta0 = rnd() * Math.PI * 2;
        }

        // brightness: brighter toward core
        var bright = 0.35 + (1 - r0) * 0.75 + rnd() * 0.25;
        bright = clamp(bright, 0.18, 1.15);

        // size: bigger near core, plus a few large bloom stars
        var size = 0.7 + (1 - r0) * 1.8 + rnd() * 1.0;
        if (rnd() < 0.04) size += 1.6 + rnd() * 2.0;

        P[i] = {
          r0: r0,
          th0: theta0,
          size: size,
          bright: bright,
          tw: rnd() * Math.PI * 2,      // twinkle phase
          tws: 0.4 + rnd() * 1.2,       // twinkle speed
          hueJ: (rnd() - 0.5) * 26      // per-star hue jitter
        };
      }
      state.P = P;

      // ---- background star dust ----
      var sn = clamp(Math.floor(w * h * 0.00018), 80, 360) | 0;
      var S = new Array(sn);
      for (var j = 0; j < sn; j++){
        S[j] = {
          x: rnd() * w,
          y: rnd() * h,
          s: 0.5 + rnd() * 1.1,
          tw: rnd() * Math.PI * 2,
          tws: 0.3 + rnd() * 0.9,
          base: 0.06 + rnd() * 0.16,
          hue: 200 + rnd() * 60,
          // very slow drift so dust is never pixel-static (burn-in safety)
          dx: (rnd() - 0.5) * 2.2,
          dy: (rnd() - 0.5) * 2.2,
          dph: rnd() * Math.PI * 2,
          dsp: 0.01 + rnd() * 0.02
        };
      }
      state.S = S;

      state.cx = w * 0.5;
      state.cy = h * 0.5;
      state.w = w;
      state.h = h;

      // overall galaxy precession (very slow tilt wobble)
      state.tiltPhase = rnd() * Math.PI * 2;
      // slow drift of the whole galaxy center so the bright core never
      // occupies exactly the same pixels for long (OLED burn-in safety)
      state.driftPhX = rnd() * Math.PI * 2;
      state.driftPhY = rnd() * Math.PI * 2;
      state.driftRX = minDim * 0.05;
      state.driftRY = minDim * 0.04;

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0 || !state || !state.P || !state.P.length) return;
      if (dt > 0.12) dt = 0.12; // guard frame spikes

      var P = state.P, S = state.S;
      var R = state.R, dir = state.dir;

      // slow center drift -> moves the whole bright core around over minutes
      var cx = state.cx + Math.sin(t * 0.017 + state.driftPhX) * state.driftRX;
      var cy = state.cy + Math.cos(t * 0.013 + state.driftPhY) * state.driftRY;

      // motion-trail background for soft luminous persistence on true black.
      // 0.16 is opaque enough that trails decay in a fraction of a second,
      // keeping average luminance low and avoiding any static bright build-up.
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(0, 0, w, h);

      var TWO_PI = Math.PI * 2;

      // ---- background star dust (additive, subtle twinkle + slow drift) ----
      ctx.globalCompositeOperation = "lighter";
      for (var j = 0; j < S.length; j++){
        var st = S[j];
        var tw = 0.5 + 0.5 * Math.sin(t * st.tws + st.tw);
        var a = st.base * (0.5 + tw * 0.7);
        if (a < 0.01) continue;
        // slow circular drift so dust pixels are never static
        var sx = st.x + Math.sin(t * st.dsp + st.dph) * st.dx;
        var sy = st.y + Math.cos(t * st.dsp + st.dph) * st.dy;
        ctx.globalAlpha = a;
        ctx.fillStyle = "hsl(" + st.hue.toFixed(0) + ",70%,82%)";
        ctx.beginPath();
        ctx.arc(sx, sy, st.s, 0, TWO_PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ---- subtle galaxy tilt + gentle whole-disc roll ----
      var tilt = 0.62 + 0.06 * Math.sin(t * 0.05 + state.tiltPhase); // y-squash
      var planeRot = Math.sin(t * 0.013) * 0.25;
      var cosPR = Math.cos(planeRot), sinPR = Math.sin(planeRot);

      // ---- soft glowing core (layered radial gradients), gently breathing ----
      var corePulse = 0.85 + 0.15 * Math.sin(t * 0.22);
      var coreR = R * 0.34 * corePulse;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      g.addColorStop(0.0, "rgba(255,238,200,0.95)");
      g.addColorStop(0.18, "rgba(255,206,130,0.55)");
      g.addColorStop(0.45, "rgba(220,150,90,0.20)");
      g.addColorStop(1.0, "rgba(120,90,160,0.0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, TWO_PI);
      ctx.fill();

      // faint extended halo (cool) — large but very dim
      var halo = ctx.createRadialGradient(cx, cy, coreR * 0.5, cx, cy, R * 1.05);
      halo.addColorStop(0.0, "rgba(110,130,200,0.06)");
      halo.addColorStop(0.55, "rgba(70,90,170,0.03)");
      halo.addColorStop(1.0, "rgba(0,0,0,0.0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.05, 0, TWO_PI);
      ctx.fill();

      // ---- particles with differential rotation ----
      var baseOmega = dir * 0.10;

      for (var i = 0; i < P.length; i++){
        var p = P[i];
        var rN = p.r0;
        if (rN > 1.05) continue;

        // differential angular velocity (clamped so center doesn't spin insanely)
        var omega = baseOmega * (0.35 + 0.9 / (rN * 2.4 + 0.5));
        var th = p.th0 + t * omega;

        var rr2 = rN * R;
        var lx = Math.cos(th) * rr2;
        var ly = Math.sin(th) * rr2;

        // whole-disc roll
        var rx = lx * cosPR - ly * sinPR;
        var ry = lx * sinPR + ly * cosPR;

        // tilt (squash y) -> screen
        var x = cx + rx;
        var y = cy + ry * tilt;

        // twinkle brightness
        var twk = 0.72 + 0.28 * Math.sin(t * p.tws + p.tw);
        var alpha = p.bright * twk * 0.5;
        alpha *= (1.0 - rN * 0.45); // outer arms dimmer
        if (alpha < 0.012) continue;
        alpha = clamp(alpha, 0, 0.9);

        // hue: warm gold core -> cool blue outer
        var hue = 42 + rN * 168 + p.hueJ;
        if (hue < 0) hue += 360;
        else if (hue >= 360) hue -= 360;
        var sat = 60 + rN * 25;
        var light = 70 - rN * 8;

        var sz = p.size * (1.0 + 0.15 * Math.sin(t * p.tws * 0.5 + p.tw));
        if (sz < 0.1) sz = 0.1;

        if (sz > 1.9 || alpha > 0.4){
          var gr = sz * 4.2;
          var rg = ctx.createRadialGradient(x, y, 0, x, y, gr);
          var col = "hsla(" + hue.toFixed(0) + "," + sat.toFixed(0) + "%," + light.toFixed(0) + "%,";
          rg.addColorStop(0.0, col + alpha.toFixed(3) + ")");
          rg.addColorStop(0.35, col + (alpha * 0.45).toFixed(3) + ")");
          rg.addColorStop(1.0, col + "0)");
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(x, y, gr, 0, TWO_PI);
          ctx.fill();
        } else {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "hsl(" + hue.toFixed(0) + "," + sat.toFixed(0) + "%," + light.toFixed(0) + "%)";
          ctx.beginPath();
          ctx.arc(x, y, sz, 0, TWO_PI);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // restore state for next scene
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  });
})();
