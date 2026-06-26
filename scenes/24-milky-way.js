(function () {
  "use strict";

  // ---------- PRNG (mulberry32) ----------
  function makePRNG(seed) {
    var s = seed >>> 0;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- value noise (2D), seeded ----------
  function makeNoise(rng) {
    var perm = new Uint8Array(512);
    var p = new Uint8Array(256);
    var i;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (i = 0; i < 512; i++) perm[i] = p[i & 255];

    function fade(x) { return x * x * x * (x * (x * 6 - 15) + 10); }
    function grad(h, x, y) {
      // hash to a pseudo gradient
      switch (h & 3) {
        case 0: return x + y;
        case 1: return -x + y;
        case 2: return x - y;
        default: return -x - y;
      }
    }
    function lerp(a, b, t) { return a + (b - a) * t; }

    // returns approximately [-1, 1]
    return function (x, y) {
      var X = Math.floor(x) & 255;
      var Y = Math.floor(y) & 255;
      var xf = x - Math.floor(x);
      var yf = y - Math.floor(y);
      var u = fade(xf);
      var v = fade(yf);
      var aa = perm[perm[X] + Y];
      var ab = perm[perm[X] + Y + 1];
      var ba = perm[perm[X + 1] + Y];
      var bb = perm[perm[X + 1] + Y + 1];
      var x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
      var x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
      return lerp(x1, x2, v);
    };
  }

  function fbm(noise, x, y, oct, lac, gain) {
    var amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm; // ~[-1,1]
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // ---------- scene ----------
  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Milky Way Rising",

    setup: function (ctx, w, h) {
      var state = {};
      if (w <= 0 || h <= 0) { state.bad = true; return state; }

      var dpr = ctx.oledDPR || 1.0;
      var px = dpr > 0 ? 1 / dpr : 0.6; // one device pixel in CSS units
      state.px = px;

      var rng = makePRNG(0x9E3779B1 ^ ((w * 73856093) >>> 0) ^ ((h * 19349663) >>> 0) ^ 0xABCDEF);
      state.rng = rng;
      state.noise = makeNoise(rng);

      var area = w * h;
      var areaScale = area / (1920 * 1080);

      // ---- galactic band geometry ----
      // The band crosses the frame diagonally. We work in a rotated
      // coordinate frame: u = along band, v = across band.
      var bandAngle = -0.62 + (rng() - 0.5) * 0.12; // radians, gentle diagonal
      state.bandAngle = bandAngle;
      state.cosA = Math.cos(bandAngle);
      state.sinA = Math.sin(bandAngle);
      state.cx = w * 0.5;
      state.cy = h * 0.5;
      // half-width of the bright band region across (v) axis
      state.bandHalf = Math.min(w, h) * 0.34;
      // core position offset along the band (u axis), drifts
      state.coreU0 = (rng() - 0.5) * Math.max(w, h) * 0.25;

      // diagonal extent for safe coverage
      var diag = Math.sqrt(w * w + h * h) * 0.62;
      state.diag = diag;

      // ---- band stars (the dense galactic-plane haze of faint stars) ----
      // distributed in (u,v) space, gaussian-ish across v, dense.
      var bandCount = Math.min(5200, Math.floor(2600 * areaScale));
      var bu = new Float32Array(bandCount);
      var bv = new Float32Array(bandCount);
      var bb = new Float32Array(bandCount);   // base brightness
      var bs = new Float32Array(bandCount);   // size factor
      var btw = new Float32Array(bandCount);  // twinkle phase
      var bch = new Float32Array(bandCount);  // color hue mix 0..1 (0 cool,1 warm)
      var i;
      for (i = 0; i < bandCount; i++) {
        bu[i] = (rng() * 2 - 1) * diag;
        // gaussian-ish across band: sum of uniforms -> bell, scaled by bandHalf
        var g = (rng() + rng() + rng() - 1.5);
        bv[i] = g * state.bandHalf * 1.05;
        // faint distribution: heavily weighted to dim
        var r = rng();
        bb[i] = 0.05 + r * r * r * 0.85;
        bs[i] = 0.7 + rng() * 0.9;
        btw[i] = rng() * Math.PI * 2;
        // band stars slightly warmer/yellower on average (galactic core hue)
        bch[i] = rng() * rng();
      }
      state.bu = bu; state.bv = bv; state.bb = bb; state.bs = bs;
      state.btw = btw; state.bch = bch; state.bandCount = bandCount;

      // ---- foreground field stars (crisp pinpoints over everything) ----
      var fgCount = Math.min(1400, Math.floor(800 * areaScale));
      var fx = new Float32Array(fgCount);
      var fy = new Float32Array(fgCount);
      var fb = new Float32Array(fgCount);
      var fs = new Float32Array(fgCount);
      var ftw = new Float32Array(fgCount);
      var fch = new Float32Array(fgCount);
      var fspk = new Uint8Array(fgCount); // has diffraction spikes
      for (i = 0; i < fgCount; i++) {
        fx[i] = rng();              // normalized 0..1 (drifts in draw)
        fy[i] = rng();
        var rr = rng();
        fb[i] = 0.08 + rr * rr * rr * 0.92; // mostly faint
        fs[i] = 0.55 + rng() * 1.0;
        ftw[i] = rng() * Math.PI * 2;
        fch[i] = rng() * rng() < 0.22 ? (0.6 + rng() * 0.4) : rng() * 0.35; // mostly cool
        fspk[i] = (fb[i] > 0.82 && rng() < 0.5) ? 1 : 0;
      }
      state.fx = fx; state.fy = fy; state.fb = fb; state.fs = fs;
      state.ftw = ftw; state.fch = fch; state.fspk = fspk; state.fgCount = fgCount;

      // ---- nebulosity blobs (faint dusty additive gradients, in band frame) ----
      var nebCount = Math.min(26, Math.floor(18 * areaScale) + 8);
      var neb = [];
      for (i = 0; i < nebCount; i++) {
        var warm = rng();
        neb.push({
          u: (rng() * 2 - 1) * diag * 0.95,
          v: (rng() + rng() - 1) * state.bandHalf * 1.1,
          r: (0.10 + rng() * 0.28) * Math.min(w, h),
          a: 0.012 + rng() * 0.03,
          // dusty palette: muted browns/golds near core, faint blue elsewhere
          warm: warm,
          ph: rng() * Math.PI * 2,
          sp: 0.04 + rng() * 0.06
        });
      }
      state.neb = neb;

      // ---- dust lanes: precompute nothing heavy; handled via noise in draw ----
      state.dustScale = 0.0042 + rng() * 0.001;
      state.dustSeedX = rng() * 1000;
      state.dustSeedY = rng() * 1000;

      // drift speeds (very slow)
      state.driftAlong = 5.5;   // px/sec along band
      state.driftAcross = 0.0;  // keep band centered-ish
      state.fieldDrift = 0.0035; // normalized/sec for fg stars
      state.t0 = 0;

      // offscreen dust-lane layer rendered occasionally (cheap, in band frame)
      // We'll draw dust as soft dark strokes derived from fbm at draw time but
      // sampled on a coarse grid precomputed here for performance.
      var gw = 64, gh = 40;
      state.gw = gw; state.gh = gh;
      state.dust = new Float32Array(gw * gh);
      var nz = state.noise;
      for (var gy = 0; gy < gh; gy++) {
        for (var gx = 0; gx < gw; gx++) {
          // map grid to band frame u,v
          var uu = (gx / (gw - 1) - 0.5) * 2 * diag;
          var vv = (gy / (gh - 1) - 0.5) * 2 * state.bandHalf * 1.3;
          // ridged fbm to make rift-like dark lanes
          var n = fbm(nz, uu * 0.0016 + 11.3, vv * 0.004 + 4.1, 5, 2.1, 0.55);
          var rift = 1 - Math.abs(n);     // ridges
          rift = Math.pow(rift, 2.2);
          // also a coarser modulation so lanes are not uniform
          var n2 = fbm(nz, uu * 0.0006 - 7.7, vv * 0.0015 + 2.2, 3, 2.0, 0.5);
          rift *= 0.55 + 0.45 * (n2 * 0.5 + 0.5);
          state.dust[gy * gw + gx] = rift;
        }
      }

      return state;
    },

    draw: function (ctx, w, h, t, dt, state) {
      if (!state || state.bad || w <= 0 || h <= 0) {
        if (w > 0 && h > 0) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); }
        return;
      }
      if (dt > 0.05) dt = 0.05;
      if (dt < 0) dt = 0;

      var px = state.px;

      // ---- background: true black ----
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      var cosA = state.cosA, sinA = state.sinA;
      var cx = state.cx, cy = state.cy;
      var bandHalf = state.bandHalf;
      var diag = state.diag;

      // global slow drift of the band along its axis (wraps)
      var along = (t * state.driftAlong);
      // also a very slow breathing of the field rotation to avoid pinning
      var sway = Math.sin(t * 0.013) * 0.018;
      var c2 = Math.cos(state.bandAngle + sway);
      var s2 = Math.sin(state.bandAngle + sway);

      // helper: band (u,v) -> screen (x,y)
      // x = cx + u*cos - v*sin ; y = cy + u*sin + v*cos
      function toScreenX(u, v) { return cx + u * c2 - v * s2; }
      function toScreenY(u, v) { return cy + u * s2 + v * c2; }

      // core glow position drifts slowly along band
      var coreU = state.coreU0 + Math.sin(t * 0.02) * diag * 0.18 + along * 0.15;
      var coreV = Math.sin(t * 0.017) * bandHalf * 0.12;
      var coreX = toScreenX(coreU, coreV);
      var coreY = toScreenY(coreU, coreV);

      // ====== LAYER 1: faint band haze (broad soft glow of the plane) ======
      ctx.globalCompositeOperation = "lighter";

      // The whole galactic band as an elongated soft gradient (the haze).
      // Render several overlapping radial gradients positioned along u.
      var hazeSteps = 9;
      for (var hsi = 0; hsi < hazeSteps; hsi++) {
        var fu = (hsi / (hazeSteps - 1) - 0.5) * 2 * diag * 0.92;
        var hv = Math.sin(t * 0.01 + hsi) * bandHalf * 0.05;
        var hx = toScreenX(fu, hv);
        var hy = toScreenY(fu, hv);
        // brightness rises toward core
        var dCore = Math.abs(fu - coreU) / (diag);
        var hb = clamp(1 - dCore * 1.25, 0, 1);
        hb = 0.12 + hb * hb * 0.55;
        var rad = bandHalf * (1.5 + 0.4 * Math.sin(t * 0.02 + hsi * 1.7));
        var g = ctx.createRadialGradient(hx, hy, 0, hx, hy, rad);
        // muted dusty grey-gold haze
        var warm = clamp(1 - dCore * 1.4, 0, 1);
        var rr = Math.floor(28 + warm * 26);
        var gg = Math.floor(26 + warm * 20);
        var bbч = Math.floor(30 + (1 - warm) * 14);
        var aHaze = (0.05 + hb * 0.05);
        g.addColorStop(0, "rgba(" + rr + "," + gg + "," + bbч + "," + aHaze.toFixed(3) + ")");
        g.addColorStop(0.5, "rgba(" + rr + "," + gg + "," + bbч + "," + (aHaze * 0.45).toFixed(3) + ")");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(hx, hy, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      // ====== LAYER 2: nebulosity blobs (faint dusty color) ======
      var neb = state.neb;
      for (var ni = 0; ni < neb.length; ni++) {
        var nb = neb[ni];
        var pulse = 0.7 + 0.3 * Math.sin(t * nb.sp + nb.ph);
        var nu = nb.u + Math.sin(t * 0.008 + nb.ph) * 18;
        var nv = nb.v + Math.cos(t * 0.006 + nb.ph) * 12;
        var nx = toScreenX(nu, nv);
        var ny = toScreenY(nu, nv);
        var nr = nb.r * (0.9 + 0.15 * Math.sin(t * 0.01 + nb.ph));
        var ga = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
        var a = nb.a * pulse;
        var R, G, B;
        if (nb.warm > 0.55) { // dusty gold/amber near core
          R = 60; G = 42; B = 24;
        } else if (nb.warm > 0.3) { // faint rose
          R = 50; G = 30; B = 38;
        } else { // faint cool blue
          R = 26; G = 34; B = 54;
        }
        ga.addColorStop(0, "rgba(" + R + "," + G + "," + B + "," + a.toFixed(3) + ")");
        ga.addColorStop(0.55, "rgba(" + R + "," + G + "," + B + "," + (a * 0.4).toFixed(3) + ")");
        ga.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = ga;
        ctx.beginPath();
        ctx.arc(nx, ny, nr, 0, Math.PI * 2);
        ctx.fill();
      }

      // ====== LAYER 3: bright softly-glowing core ======
      var coreR = Math.min(w, h) * 0.42;
      var corePulse = 0.85 + 0.15 * Math.sin(t * 0.05);
      var cg = ctx.createRadialGradient(coreX, coreY, 0, coreX, coreY, coreR);
      cg.addColorStop(0, "rgba(86,70,46," + (0.10 * corePulse).toFixed(3) + ")");
      cg.addColorStop(0.35, "rgba(60,50,36," + (0.055 * corePulse).toFixed(3) + ")");
      cg.addColorStop(0.7, "rgba(40,34,30," + (0.02 * corePulse).toFixed(3) + ")");
      cg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(coreX, coreY, coreR, 0, Math.PI * 2);
      ctx.fill();
      // tighter inner core
      var coreR2 = coreR * 0.4;
      var cg2 = ctx.createRadialGradient(coreX, coreY, 0, coreX, coreY, coreR2);
      cg2.addColorStop(0, "rgba(110,92,62," + (0.10 * corePulse).toFixed(3) + ")");
      cg2.addColorStop(0.5, "rgba(72,58,40," + (0.04 * corePulse).toFixed(3) + ")");
      cg2.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = cg2;
      ctx.beginPath();
      ctx.arc(coreX, coreY, coreR2, 0, Math.PI * 2);
      ctx.fill();

      // ====== LAYER 4: band stars (dense faint pinpoints in the plane) ======
      // drawn additively so they sit in the haze; size in device px.
      var bu = state.bu, bv = state.bv, bb = state.bb, bs = state.bs;
      var btw = state.btw, bch = state.bch, bandCount = state.bandCount;
      var twoDiag = diag * 2;
      for (var i = 0; i < bandCount; i++) {
        // drift along band with wrap
        var u = bu[i] + along * 0.55;
        // wrap into [-diag, diag]
        u = ((u + diag) % twoDiag + twoDiag) % twoDiag - diag;
        var v = bv[i];
        var sx = toScreenX(u, v);
        var sy = toScreenY(u, v);
        if (sx < -4 || sx > w + 4 || sy < -4 || sy > h + 4) continue;

        // dust-lane occlusion: sample precomputed dust grid in band frame
        var gx = (u / twoDiag + 0.5) * (state.gw - 1);
        var gy = (v / (bandHalf * 2.6) + 0.5) * (state.gh - 1);
        var occ = 1;
        if (gx >= 0 && gx < state.gw && gy >= 0 && gy < state.gh) {
          var gix = gx | 0, giy = gy | 0;
          var d = state.dust[giy * state.gw + gix];
          // dust value high = rift; reduce star brightness there
          occ = clamp(1 - d * 0.85, 0.12, 1);
        }

        var tw = 0.82 + 0.18 * Math.sin(t * 0.9 + btw[i]);
        var br = bb[i] * tw * occ;
        if (br < 0.02) continue;

        // color: cool to warm-gold
        var warm = bch[i];
        var R = Math.floor(170 + warm * 70);
        var G = Math.floor(175 + warm * 30);
        var B = Math.floor(200 - warm * 70);
        var sz = bs[i] * (0.85 + br * 1.3) * px * 1.15;
        if (sz < px * 0.6) sz = px * 0.6;

        ctx.fillStyle = "rgba(" + R + "," + G + "," + B + "," + (br * 0.9).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(sx, sy, sz, 0, Math.PI * 2);
        ctx.fill();
      }

      // ====== LAYER 5: foreground field stars (crisp pinpoints everywhere) ======
      var fx = state.fx, fy = state.fy, fb = state.fb, fs = state.fs;
      var ftw = state.ftw, fch = state.fch, fspk = state.fspk, fgCount = state.fgCount;
      var fdrift = t * state.fieldDrift;
      for (var k = 0; k < fgCount; k++) {
        // gentle 2D drift (wrap normalized coords)
        var nx2 = fx[k] + fdrift * 0.6;
        var ny2 = fy[k] + fdrift * 0.22 + 0.0;
        nx2 = nx2 - Math.floor(nx2);
        ny2 = ny2 - Math.floor(ny2);
        var X = nx2 * w;
        var Y = ny2 * h;

        var tw = 0.78 + 0.22 * Math.sin(t * 1.4 + ftw[k]);
        var br = fb[k] * tw;
        var warm = fch[k];
        var R = Math.floor(200 + warm * 55);
        var G = Math.floor(210 - warm * 20);
        var B = Math.floor(235 - warm * 120);

        var sz = fs[k] * (0.8 + br * 1.4) * px * 1.2;
        if (sz < px * 0.55) sz = px * 0.55;

        // faint halo for brighter stars (additive)
        if (br > 0.55) {
          var hr = sz * (5 + br * 6);
          var hg = ctx.createRadialGradient(X, Y, 0, X, Y, hr);
          hg.addColorStop(0, "rgba(" + R + "," + G + "," + B + "," + (br * 0.18).toFixed(3) + ")");
          hg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = hg;
          ctx.beginPath();
          ctx.arc(X, Y, hr, 0, Math.PI * 2);
          ctx.fill();
        }

        // core dot
        ctx.fillStyle = "rgba(" + R + "," + G + "," + B + "," + clamp(br * 1.05, 0, 1).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(X, Y, sz, 0, Math.PI * 2);
        ctx.fill();

        // diffraction spikes on a few bright stars
        if (fspk[k] && br > 0.6) {
          var spikeLen = sz * (10 + br * 14);
          var sa = br * 0.22;
          ctx.strokeStyle = "rgba(" + R + "," + G + "," + B + "," + sa.toFixed(3) + ")";
          ctx.lineWidth = px;
          ctx.beginPath();
          ctx.moveTo(X - spikeLen, Y); ctx.lineTo(X + spikeLen, Y);
          ctx.moveTo(X, Y - spikeLen); ctx.lineTo(X, Y + spikeLen);
          ctx.stroke();
        }
      }

      // ---- reset ctx to clean state ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
  });
})();