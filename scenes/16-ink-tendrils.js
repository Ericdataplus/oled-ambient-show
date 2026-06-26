(function(){
  "use strict";

  // ---------- PRNG (mulberry32) ----------
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Gradient (Perlin-style) value noise ----------
  function makeNoise(seed){
    var rand = mulberry32(seed >>> 0);
    var perm = new Uint8Array(256);
    var P = new Uint16Array(512);
    var i;
    for (i = 0; i < 256; i++) perm[i] = i;
    for (i = 255; i > 0; i--){
      var j = (rand() * (i + 1)) | 0;
      var tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    for (i = 0; i < 512; i++) P[i] = perm[i & 255];

    var g2 = new Float32Array(256 * 2);
    for (i = 0; i < 256; i++){
      var ang = rand() * Math.PI * 2;
      g2[(i * 2)] = Math.cos(ang);
      g2[(i * 2) + 1] = Math.sin(ang);
    }
    function fade(tt){ return tt * tt * tt * (tt * (tt * 6 - 15) + 10); }
    function lerp(a, b, tt){ return a + (b - a) * tt; }
    function grad(hash, x, y){
      var idx = (hash & 255) * 2;
      return g2[idx] * x + g2[idx + 1] * y;
    }
    return function(x, y){
      var X = Math.floor(x) & 255;
      var Y = Math.floor(y) & 255;
      var xf = x - Math.floor(x);
      var yf = y - Math.floor(y);
      var u = fade(xf);
      var v = fade(yf);
      var aa = P[P[X] + Y];
      var ab = P[P[X] + Y + 1];
      var ba = P[P[X + 1] + Y];
      var bb = P[P[X + 1] + Y + 1];
      var x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
      var x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
      return lerp(x1, x2, v); // ~[-1,1]
    };
  }

  // ---------- color helpers ----------
  var PAL = [
    [ 96, 110, 255],  // indigo
    [180,  90, 255],  // violet
    [255,  90, 210],  // magenta
    [120, 200, 255],  // cyan-blue
    [ 90, 255, 235]   // cyan
  ];
  // writes into out[0..2] to avoid per-frame allocation
  function palColor(p, out){
    p = p - Math.floor(p);
    var f = p * (PAL.length - 1);
    var i = f | 0;
    if (i >= PAL.length - 1) i = PAL.length - 2;
    var fr = f - i;
    var a = PAL[i], b = PAL[i + 1];
    out[0] = a[0] + (b[0] - a[0]) * fr;
    out[1] = a[1] + (b[1] - a[1]) * fr;
    out[2] = a[2] + (b[2] - a[2]) * fr;
  }

  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

  window.OLED_SCENES = window.OLED_SCENES || [];

  window.OLED_SCENES.push({
    name: "Ink Tendrils",

    setup: function(ctx, w, h){
      var state = {};
      if (w <= 0 || h <= 0) { state.bad = true; return state; }
      state.bad = false;

      var seed = ((Date.now() >>> 0) ^ 0x1234abcd) >>> 0;
      state.rand = mulberry32(seed);
      state.noise = makeNoise(seed ^ 0x9e3779b9);
      state.noise2 = makeNoise((seed ^ 0x85ebca6b) >>> 0);

      var area = w * h;
      // capped pool sizing (scale by area, clamp hard for 60fps under SSAA)
      var MAX = Math.min(40, Math.max(12, Math.round(area / 52000)));
      state.MAX = MAX;

      // each tendril keeps a trail of recent points (ring buffer) for a tapering hairline
      state.TRAIL = 56;

      var tendrils = new Array(MAX);
      for (var i = 0; i < MAX; i++){
        tendrils[i] = {
          alive: false,
          tx: new Float32Array(state.TRAIL),
          ty: new Float32Array(state.TRAIL),
          tn: 0,
          head: 0,
          x: 0, y: 0,
          dir: 0,
          age: 0,
          life: 1,
          speed: 0,
          hue: 0,
          width: 1,
          fade: 0,
          depositAccum: 0,
          stepLen: 0,
          children: 0,
          maxChildren: 0,
          generation: 0,
          curlScale: 0.0025,
          glowPhase: 0
        };
      }
      state.tendrils = tendrils;

      // composition slow drift to avoid pinning anchors
      state.driftPhase = state.rand() * Math.PI * 2;

      // staggered spawn timer
      state.spawnTimer = 0.2;
      state.spawnInterval = 0.4;

      state.w = w; state.h = h;
      state.maxDim = Math.sqrt(area);

      // scratch color (avoid per-frame allocation)
      state.col = [0, 0, 0];

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (!state || state.bad || w <= 0 || h <= 0) return;
      if (dt > 0.05) dt = 0.05; // clamp spikes
      if (dt < 0) dt = 0;

      var dpr = ctx.oledDPR;
      var hair = (dpr && dpr > 0) ? (1 / dpr) : 0.6; // one device pixel (0.6 CSS fallback)

      // --- background: gentle trail fade for soft ink-in-water afterglow ---
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.085)";
      ctx.fillRect(0, 0, w, h);

      var tendrils = state.tendrils;
      var MAX = state.MAX;
      var TRAIL = state.TRAIL;
      var noise = state.noise;
      var noise2 = state.noise2;
      var rand = state.rand;
      var col = state.col;

      // slow whole-composition drift (sub-pixel-per-frame) so nothing pins
      var driftX = Math.cos(t * 0.013 + state.driftPhase) * 0.20;
      var driftY = Math.sin(t * 0.0107 + state.driftPhase * 1.3) * 0.20;

      // ---- spawning ----
      state.spawnTimer -= dt;
      var aliveCount = 0;
      var k;
      for (k = 0; k < MAX; k++) if (tendrils[k].alive) aliveCount++;

      function findDead(){
        for (var i = 0; i < MAX; i++) if (!tendrils[i].alive) return tendrils[i];
        return null;
      }

      function spawn(x, y, dir, hue, gen, life, width, speed){
        var td = findDead();
        if (!td) return null;
        td.alive = true;
        td.x = x; td.y = y;
        td.dir = dir;
        td.age = 0;
        td.life = life;
        td.speed = speed;
        td.hue = hue;
        td.width = width;
        td.fade = 0;
        td.depositAccum = 0;
        td.tn = 0;
        td.head = 0;
        td.children = 0;
        td.maxChildren = gen < 3 ? (2 + ((rand() * 2) | 0)) : 0;
        td.generation = gen;
        td.curlScale = 0.0018 + rand() * 0.0016;
        td.glowPhase = rand() * Math.PI * 2;
        // seed first trail point
        td.tx[0] = x; td.ty[0] = y; td.tn = 1; td.head = 0;
        return td;
      }

      if (state.spawnTimer <= 0 && aliveCount < MAX - 6){
        state.spawnTimer = state.spawnInterval * (0.6 + rand() * 0.9);
        var margin = state.maxDim * 0.08;
        var sx = margin + rand() * (w - margin * 2);
        var sy = margin + rand() * (h - margin * 2);
        var sdir = rand() * Math.PI * 2;
        var shue = rand();
        var life = 7 + rand() * 6;
        var width = 1.7 + rand() * 1.1;
        var speed = state.maxDim * (0.018 + rand() * 0.012);
        spawn(sx, sy, sdir, shue, 0, life, width, speed);
      }

      // ---- update + draw each tendril ----
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      var hueDrift = t * 0.012; // whole-scene slow palette rotation

      for (k = 0; k < MAX; k++){
        var td = tendrils[k];
        if (!td.alive) continue;

        td.age += dt;
        var lifeT = td.age / td.life; // 0..1
        if (lifeT >= 1){
          td.alive = false;
          continue;
        }

        // opacity envelope: quick rise, long slow fade
        var env;
        if (lifeT < 0.12) env = lifeT / 0.12;
        else env = 1 - ((lifeT - 0.12) / 0.88);
        env = clamp(env, 0, 1);
        env = env * env * (3 - 2 * env); // smoothstep
        td.fade = env;

        // advance the tip using curl noise
        var steps = 2;
        for (var s = 0; s < steps; s++){
          var cs = td.curlScale;
          var nx = td.x * cs;
          var ny = td.y * cs;
          var tt = t * 0.05 + td.generation * 3.1;
          var e = 1.2;
          var n1 = noise(nx + e, ny) - noise(nx - e, ny);
          var n2 = noise(nx, ny + e) - noise(nx, ny - e);
          var m1 = (noise2(nx * 2.3 + 5 + tt, ny * 2.3) - noise2(nx * 2.3 - 5 + tt, ny * 2.3)) * 0.5;
          var m2 = (noise2(nx * 2.3, ny * 2.3 + 5) - noise2(nx * 2.3, ny * 2.3 - 5)) * 0.5;
          var curlX = (n2 + m2);
          var curlY = -(n1 + m1);
          var targetDir = Math.atan2(curlY, curlX);

          var diff = targetDir - td.dir;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          td.dir += diff * 0.22;

          var step = (td.speed * dt) / steps;
          td.stepLen = step;
          td.x += Math.cos(td.dir) * step + driftX / steps;
          td.y += Math.sin(td.dir) * step + driftY / steps;

          td.depositAccum += step;
          var depositEvery = Math.max(1.2, state.maxDim * 0.0035);
          if (td.depositAccum >= depositEvery){
            td.depositAccum = 0;
            td.head = (td.head + 1) % TRAIL;
            td.tx[td.head] = td.x;
            td.ty[td.head] = td.y;
            if (td.tn < TRAIL) td.tn++;
          }
        }

        // if tip wanders off-canvas significantly, retire it
        var pad = state.maxDim * 0.12;
        if (td.x < -pad || td.x > w + pad || td.y < -pad || td.y > h + pad){
          td.life = Math.min(td.life, td.age + 0.8);
        }

        // ---- spawn branches occasionally (filigree) ----
        if (td.maxChildren > 0 && td.children < td.maxChildren &&
            lifeT > 0.18 && lifeT < 0.7 && rand() < 0.02){
          td.children++;
          var bdir = td.dir + (rand() < 0.5 ? 1 : -1) * (0.5 + rand() * 0.7);
          var bhue = td.hue + (rand() - 0.5) * 0.12;
          var blife = td.life * (0.45 + rand() * 0.3);
          var bwidth = td.width * (0.55 + rand() * 0.2);
          var bspeed = td.speed * (0.8 + rand() * 0.3);
          spawn(td.x, td.y, bdir, bhue, td.generation + 1, blife, bwidth, bspeed);
        }

        // ---- DRAW the tendril as a tapering hairline ----
        if (td.tn >= 2){
          var huePos = td.hue + hueDrift;
          palColor(huePos, col);
          var cr = col[0] | 0, cg = col[1] | 0, cb = col[2] | 0;
          var colStr = "rgb(" + cr + "," + cg + "," + cb + ")";

          // additive for luminous glow
          ctx.globalCompositeOperation = "lighter";
          ctx.strokeStyle = colStr;

          var count = td.tn;
          var prevX = 0, prevY = 0, havePrev = false;
          for (var ii = 0; ii < count; ii++){
            var idx = (td.head - (count - 1) + ii);
            idx = ((idx % TRAIL) + TRAIL) % TRAIL;
            var px = td.tx[idx];
            var py = td.ty[idx];

            if (havePrev){
              var frac = ii / (count - 1); // 0 oldest .. 1 tip
              var taper = Math.sin(frac * Math.PI); // 0 at ends, 1 mid
              // genuinely fine: a hairline base plus a thin taper, capped tight
              var wWidth = hair + td.width * (0.25 + 0.55 * taper);
              var cap = td.width * 1.4 + hair;
              if (wWidth > cap) wWidth = cap;

              var bright = (0.10 + 0.9 * frac * frac) * td.fade;
              if (bright <= 0.003){ prevX = px; prevY = py; continue; }

              ctx.globalAlpha = clamp(bright * 0.5, 0, 1);
              ctx.lineWidth = wWidth < hair ? hair : wWidth;
              ctx.beginPath();
              ctx.moveTo(prevX, prevY);
              ctx.lineTo(px, py);
              ctx.stroke();
            }
            prevX = px; prevY = py; havePrev = true;
          }

          // ---- glowing tip: soft additive bloom + pin-sharp core ----
          var tipX = td.x, tipY = td.y;
          var tipBright = td.fade;
          if (tipBright > 0.02){
            var glowR = (2.5 + td.width * 1.8) * (0.85 + 0.3 * Math.sin(t * 0.9 + td.glowPhase));
            if (glowR < 1) glowR = 1;
            var g = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, glowR);
            var ga = clamp(tipBright * 0.8, 0, 1);
            var hrr = cr + 60; if (hrr > 255) hrr = 255;
            var hgg = cg + 60; if (hgg > 255) hgg = 255;
            var hbb = cb + 60; if (hbb > 255) hbb = 255;
            g.addColorStop(0, "rgba(" + hrr + "," + hgg + "," + hbb + "," + ga + ")");
            g.addColorStop(0.4, "rgba(" + cr + "," + cg + "," + cb + "," + (ga * 0.35) + ")");
            g.addColorStop(1, "rgba(" + cr + "," + cg + "," + cb + ",0)");
            ctx.globalAlpha = 1;
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(tipX, tipY, glowR, 0, Math.PI * 2);
            ctx.fill();

            // pin-sharp hot core (tiny, crisp)
            ctx.globalAlpha = clamp(tipBright, 0, 1);
            var kr = cr + 110; if (kr > 255) kr = 255;
            var kg = cg + 110; if (kg > 255) kg = 255;
            var kb = cb + 110; if (kb > 255) kb = 255;
            ctx.fillStyle = "rgb(" + kr + "," + kg + "," + kb + ")";
            var coreR = hair * 1.4;
            if (coreR < 0.6) coreR = 0.6;
            ctx.beginPath();
            ctx.arc(tipX, tipY, coreR, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // ---- reset context to clean state ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
  });
})();
