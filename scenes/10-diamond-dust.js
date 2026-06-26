(function(){
  "use strict";

  // ---- PRNG: small, fast, deterministic ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

  // Color lookup -> base rgb. cat 0 cool white, 1 icy blue, 2 warm gold
  function colorFor(cat){
    if(cat === 0) return [232, 240, 255];
    if(cat === 1) return [150, 190, 255];
    return [255, 214, 150];
  }
  function rgbStr(c){ return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  // Precompute opaque color strings for the three categories (no per-frame alloc).
  var COL_RGB = [colorFor(0), colorFor(1), colorFor(2)];
  var COL_STR = [rgbStr(COL_RGB[0]), rgbStr(COL_RGB[1]), rgbStr(COL_RGB[2])];

  // Build star records for one parallax layer.
  function buildLayer(rng, w, h, count, depth){
    var stars = new Array(count);
    // wrap margin so drift wrapping is seamless even for spikes
    var M = 40;
    var fw = w + M * 2;
    var fh = h + M * 2;
    for(var i = 0; i < count; i++){
      // color category: mostly cool white, some blue, rare warm gold
      var cat;
      var cr = rng();
      if(cr < 0.62) cat = 0;        // cool white
      else if(cr < 0.97) cat = 1;   // icy blue
      else cat = 2;                 // rare warm gold

      // size: closer (higher depth) layers slightly bigger on average
      var sBase = 0.55 + depth * 0.5;
      var size = sBase + Math.pow(rng(), 2.2) * (0.9 + depth * 0.9);

      // brightness: most dim, a few bright (power curve)
      var br = 0.18 + Math.pow(rng(), 2.6) * 0.82;

      stars[i] = {
        x: rng() * fw,
        y: rng() * fh,
        size: size,
        br: br,
        cat: cat,
        // twinkle
        tph: rng() * Math.PI * 2,
        tsp: 0.25 + rng() * 0.9,           // twinkle speed
        tamp: 0.3 + rng() * 0.55,          // twinkle depth
        // spike candidate flag decided below by brightness threshold
        spike: false,
        spkph: rng() * Math.PI * 2,
        spksp: 0.18 + rng() * 0.35
      };
    }

    // Mark brightest ~2% as diffraction-spike stars.
    var idx = [];
    for(var j = 0; j < count; j++) idx.push(j);
    idx.sort(function(a, b){
      return (stars[b].br * stars[b].size) - (stars[a].br * stars[a].size);
    });
    var nSpike = Math.max(1, Math.floor(count * 0.02));
    for(var k = 0; k < nSpike && k < count; k++) stars[idx[k]].spike = true;

    return {
      stars: stars,
      fw: fw, fh: fh, M: M, depth: depth,
      vx: 0, vy: 0,   // drift velocity (CSS px/sec)
      ox: 0, oy: 0    // accumulated offset
    };
  }

  // Stroke one tapered segment of a diffraction spike (gradient = soft falloff).
  function strokeSeg(ctx, x0, y0, x1, y1, r, g, b, a0, a1){
    var grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, "rgba(" + r + "," + g + "," + b + "," + a0.toFixed(3) + ")");
    grad.addColorStop(1, "rgba(" + r + "," + g + "," + b + "," + a1.toFixed(3) + ")");
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // Draw a 2-arm diffraction spike (axis 0 = horizontal, 1 = vertical).
  function drawSpike(ctx, cx, cy, len, axis, col, a){
    var r = col[0], g = col[1], b = col[2];
    var half = len;
    var coreA = Math.min(1, a);
    var tipA = a * 0.12;
    if(axis === 0){
      strokeSeg(ctx, cx, cy, cx - half, cy, r, g, b, coreA, tipA);
      strokeSeg(ctx, cx, cy, cx + half, cy, r, g, b, coreA, tipA);
    } else {
      strokeSeg(ctx, cx, cy, cx, cy - half, r, g, b, coreA, tipA);
      strokeSeg(ctx, cx, cy, cx, cy + half, r, g, b, coreA, tipA);
    }
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Diamond Dust",

    setup: function(ctx, w, h){
      var state = {};
      if(w <= 0 || h <= 0){ state.bad = true; return state; }

      var rng = mulberry32(0x1A2B3C4D);
      var area = w * h;
      // density: very dense but capped for perf at ~2.25x buffer
      var total = clamp(Math.round(area / 950), 1200, 5200);

      // distribute across 3 parallax layers (far -> near)
      var c0 = Math.round(total * 0.5);
      var c1 = Math.round(total * 0.32);
      var c2 = total - c0 - c1;

      var L0 = buildLayer(rng, w, h, c0, 0.15); // far, smallest, slowest
      var L1 = buildLayer(rng, w, h, c1, 0.55); // mid
      var L2 = buildLayer(rng, w, h, c2, 1.0);  // near, biggest, fastest

      // drift directions: slow, slightly different per layer
      L0.vx = 1.1;  L0.vy = -0.55;
      L1.vx = -2.0; L1.vy = -1.1;
      L2.vx = 3.2;  L2.vy = 1.7;

      state.layers = [L0, L1, L2];
      state.rng = rng;
      // global slow sway so the whole field never pins
      state.swayPhX = rng() * Math.PI * 2;
      state.swayPhY = rng() * Math.PI * 2;
      state.bad = false;
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if(!state || state.bad || w <= 0 || h <= 0) return;
      if(!(dt > 0)) dt = 0;
      if(dt > 0.05) dt = 0.05; // clamp spikes

      var dpr = ctx.oledDPR || 1;
      var hair = 1 / dpr;        // one device pixel
      var px = 1 / dpr;          // device-pixel unit

      // --- background: true black, full clear (pinpoints need crisp black) ---
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      var layers = state.layers;
      var i, n, s, L;

      // global slow sway (whole composition drifts in a gentle Lissajous)
      var swayX = Math.sin(t * 0.013 + state.swayPhX) * 22;
      var swayY = Math.cos(t * 0.0097 + state.swayPhY) * 16;

      // ---- pass 1: tiny pin-sharp stars (source-over, crisp rects/arcs) ----
      ctx.globalCompositeOperation = "source-over";
      for(var li = 0; li < layers.length; li++){
        L = layers[li];
        // advance drift offset (wrapped, seamless for hours)
        L.ox = (L.ox + L.vx * dt) % L.fw;
        if(L.ox < 0) L.ox += L.fw;
        L.oy = (L.oy + L.vy * dt) % L.fh;
        if(L.oy < 0) L.oy += L.fh;

        var stars = L.stars;
        var fw = L.fw, fh = L.fh, M = L.M;
        // parallax-scaled sway (nearer layers move more with global sway)
        var pSwayX = swayX * (0.4 + L.depth * 0.6);
        var pSwayY = swayY * (0.4 + L.depth * 0.6);

        n = stars.length;
        for(i = 0; i < n; i++){
          s = stars[i];
          // wrapped position
          var x = s.x + L.ox;
          if(x >= fw) x -= fw;
          var y = s.y + L.oy;
          if(y >= fh) y -= fh;
          // map framed coords to screen (subtract margin) + sway
          var sx = x - M + pSwayX;
          var sy = y - M + pSwayY;

          // cull off-screen (with small pad)
          if(sx < -3 || sx > w + 3 || sy < -3 || sy > h + 3) continue;

          // twinkle: smooth, never to zero (no strobing)
          var tw = 0.5 + 0.5 * Math.sin(t * s.tsp + s.tph);
          var alpha = s.br * (1 - s.tamp + s.tamp * tw);
          if(alpha <= 0.012) continue;

          // size in CSS px; ensure at least ~1 device px so it stays crisp
          var drawSz = s.size;
          if(drawSz < px) drawSz = px;

          ctx.globalAlpha = clamp(alpha, 0, 1);
          ctx.fillStyle = COL_STR[s.cat];

          if(drawSz <= px * 1.6){
            // smallest/dimmest: device-pixel-snapped crisp rect (pin-sharp point)
            var rs = drawSz;
            var rx = Math.round((sx - rs * 0.5) * dpr) / dpr;
            var ry = Math.round((sy - rs * 0.5) * dpr) / dpr;
            ctx.fillRect(rx, ry, rs, rs);
          } else {
            // slightly larger: tiny round point
            ctx.beginPath();
            ctx.arc(sx, sy, drawSz * 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // ---- pass 2: brightest few get glow + breathing diffraction spikes ----
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      for(var lj = 0; lj < layers.length; lj++){
        L = layers[lj];
        var st = L.stars;
        var fw2 = L.fw, fh2 = L.fh, M2 = L.M;
        var psx = swayX * (0.4 + L.depth * 0.6);
        var psy = swayY * (0.4 + L.depth * 0.6);
        n = st.length;
        for(i = 0; i < n; i++){
          s = st[i];
          if(!s.spike) continue;

          var x2 = s.x + L.ox; if(x2 >= fw2) x2 -= fw2;
          var y2 = s.y + L.oy; if(y2 >= fh2) y2 -= fh2;
          var bx = x2 - M2 + psx;
          var by = y2 - M2 + psy;
          if(bx < -20 || bx > w + 20 || by < -20 || by > h + 20) continue;

          var tw2 = 0.5 + 0.5 * Math.sin(t * s.tsp + s.tph);
          var bbr = s.br * (0.55 + 0.45 * tw2);
          var col2 = COL_RGB[s.cat];

          // soft round glow (small radial) -- only these few, on black
          var gR = (3.2 + s.size * 2.2) * (0.8 + 0.4 * tw2);
          var ga = clamp(bbr * 0.5, 0, 0.7);
          if(ga > 0.02 && gR > 0.5){
            var grad = ctx.createRadialGradient(bx, by, 0, bx, by, gR);
            grad.addColorStop(0, "rgba(" + col2[0] + "," + col2[1] + "," + col2[2] + "," + ga.toFixed(3) + ")");
            grad.addColorStop(0.45, "rgba(" + col2[0] + "," + col2[1] + "," + col2[2] + "," + (ga * 0.28).toFixed(3) + ")");
            grad.addColorStop(1, "rgba(" + col2[0] + "," + col2[1] + "," + col2[2] + ",0)");
            ctx.globalAlpha = 1;
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(bx, by, gR, 0, Math.PI * 2);
            ctx.fill();
          }

          // breathing 4-point diffraction spike: thin crisp cross
          var breathe = 0.5 + 0.5 * Math.sin(t * s.spksp + s.spkph);
          var len = (5 + s.size * 5 + bbr * 9) * (0.55 + 0.6 * breathe);
          var spa = clamp(bbr * (0.45 + 0.45 * breathe), 0, 0.9);
          if(spa > 0.02 && len > 1){
            ctx.globalAlpha = 1;
            ctx.lineWidth = hair * 1.2; // true ~1 device-px hairline
            drawSpike(ctx, bx, by, len, 0, col2, spa);
            drawSpike(ctx, bx, by, len, 1, col2, spa);
          }
        }
      }

      // ---- reset context state for next scene ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
    }
  });

})();
