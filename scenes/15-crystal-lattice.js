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

  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

  // Cool gem palette: hue picked per-vertex from icy blues -> teal -> violet.
  // Returns [r,g,b] 0..255 for a hue 0..1 in the cool band.
  function gemColor(hh){
    var stops = [
      [60, 120, 255],   // electric blue
      [60, 200, 255],   // cyan
      [70, 255, 220],   // teal-green
      [150, 130, 255],  // violet
      [60, 120, 255]    // back to blue (loop)
    ];
    var n = stops.length - 1;
    var f = hh * n;
    var i = Math.floor(f);
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    var u = f - i;
    var a = stops[i], b = stops[i + 1];
    return [
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u,
      a[2] + (b[2] - a[2]) * u
    ];
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Crystal Lattice",

    setup: function(ctx, w, h){
      var state = {};
      if (w <= 0 || h <= 0) { state.bad = true; return state; }

      var rand = mulberry32(0x1A77ECE5 ^ (Math.floor(w) * 73856093) ^ (Math.floor(h) * 19349663));
      state.rand = rand;

      // ---- Build a 3D lattice cloud: an FCC-ish jittered grid inside a sphere ----
      var area = w * h;
      var targetN = clamp(Math.floor(area / 5200), 220, 520);

      var verts = [];   // each: {x,y,z, hue, base, ph}
      var R = 1.0;      // lattice radius (normalized)
      var gridN = Math.max(4, Math.round(Math.cbrt(targetN / 0.52))); // sphere fills ~52% of cube
      var step = (2 * R) / (gridN - 1);

      for (var ix = 0; ix < gridN; ix++){
        for (var iy = 0; iy < gridN; iy++){
          for (var iz = 0; iz < gridN; iz++){
            var x = -R + ix * step;
            var y = -R + iy * step;
            var z = -R + iz * step;
            var rr = x*x + y*y + z*z;
            if (rr > R*R) continue;
            var j = step * 0.32;
            x += (rand() - 0.5) * j;
            y += (rand() - 0.5) * j;
            z += (rand() - 0.5) * j;
            var radial = Math.sqrt(rr);
            var hue = (radial * 0.55 + rand() * 0.25) % 1;
            verts.push({
              x: x, y: y, z: z,
              hue: hue,
              base: 0.55 + rand() * 0.45,
              ph: rand() * Math.PI * 2  // twinkle phase
            });
            if (verts.length >= targetN) break;
          }
          if (verts.length >= targetN) break;
        }
        if (verts.length >= targetN) break;
      }

      state.verts = verts;
      var N = verts.length;

      // ---- Precompute near-neighbor edges (nearest-neighbor lattice bonds) ----
      var thresh = step * 1.5;
      var thresh2 = thresh * thresh;
      var edges = []; // flat array, pairs [i, j, ...]
      var maxEdges = Math.floor(N * 4.5); // safety cap (pairs)
      for (var i = 0; i < N; i++){
        var vi = verts[i];
        for (var k = i + 1; k < N; k++){
          var vj = verts[k];
          var dx = vi.x - vj.x, dy = vi.y - vj.y, dz = vi.z - vj.z;
          var d2 = dx*dx + dy*dy + dz*dz;
          if (d2 <= thresh2 && d2 > 1e-6){
            edges.push(i, k);
            if (edges.length >= maxEdges * 2) break;
          }
        }
        if (edges.length >= maxEdges * 2) break;
      }
      state.edges = edges;

      // projected coords scratch (avoid per-frame alloc)
      state.px = new Float32Array(N);
      state.py = new Float32Array(N);
      state.pz = new Float32Array(N); // camera-space depth (for fade)
      state.pv = new Float32Array(N); // visibility/scale factor

      state.step = step;
      state.R = R;
      state.dpr = (ctx && ctx.oledDPR) ? ctx.oledDPR : 1.667;
      state.hair = state.dpr ? (1 / state.dpr) : 0.6;
      if (!isFinite(state.hair) || state.hair <= 0) state.hair = 0.6;

      // gentle drift of whole composition so nothing pins
      state.driftSeedX = rand() * 1000;
      state.driftSeedY = rand() * 1000;

      // cap number of soft glow halos drawn per frame (bounds gradient allocs under SSAA)
      state.maxGlow = clamp(Math.floor(N * 0.22), 12, 90);

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (!state || state.bad || w <= 0 || h <= 0) return;
      if (dt > 0.05) dt = 0.05;

      var verts = state.verts;
      var edges = state.edges;
      var N = verts.length;
      var px = state.px, py = state.py, pz = state.pz, pv = state.pv;
      var hair = state.hair;

      // ---- background: true black with a faint trail for silky motion ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.34)";
      ctx.fillRect(0, 0, w, h);

      // ---- rotation angles: slow, multi-axis, incommensurate so never repeats ----
      var ax = t * 0.043;          // pitch
      var ay = t * 0.067;          // yaw
      var az = t * 0.021;          // roll
      var ca = Math.cos(ax), sa = Math.sin(ax);
      var cb = Math.cos(ay), sb = Math.sin(ay);
      var cc = Math.cos(az), sc = Math.sin(az);

      // ---- gentle whole-composition drift so center never pins ----
      var driftX = Math.sin(t * 0.037 + state.driftSeedX) * w * 0.045
                 + Math.cos(t * 0.019) * w * 0.02;
      var driftY = Math.cos(t * 0.029 + state.driftSeedY) * h * 0.05
                 + Math.sin(t * 0.013) * h * 0.025;

      var cx = w * 0.5 + driftX;
      var cy = h * 0.5 + driftY;

      // perspective + scale
      var scale = Math.min(w, h) * 0.34;
      scale *= 1 + Math.sin(t * 0.05) * 0.04; // subtle breathing
      var camZ = 3.0; // camera distance in lattice units
      var fov = 2.4;

      // ---- project all vertices ----
      for (var i = 0; i < N; i++){
        var v = verts[i];
        var x = v.x, y = v.y, z = v.z;

        // rotate X
        var y1 = y * ca - z * sa;
        var z1 = y * sa + z * ca;
        // rotate Y
        var x2 = x * cb + z1 * sb;
        var z2 = -x * sb + z1 * cb;
        // rotate Z
        var x3 = x2 * cc - y1 * sc;
        var y3 = x2 * sc + y1 * cc;

        var zc = z2 + camZ; // camera-space depth (>0)
        var persp = fov / zc;

        px[i] = cx + x3 * scale * persp;
        py[i] = cy + y3 * scale * persp;
        pz[i] = z2;       // -R..R, for depth fade (near camera = larger z2)
        pv[i] = persp;    // scale factor
      }

      var R = state.R;

      // ---- draw edges (thin crisp lines, additive, depth-faded) ----
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      var ne = edges.length;
      for (var e = 0; e < ne; e += 2){
        var a = edges[e], b = edges[e + 1];

        var za = pz[a], zb = pz[b];
        var dmid = ((za + zb) * 0.5 + R) / (2 * R); // 0..1
        if (dmid < 0) dmid = 0; else if (dmid > 1) dmid = 1;

        var depthF = 0.18 + dmid * dmid * 0.82;
        var alpha = depthF * 0.30;
        if (alpha < 0.012) continue;

        var col = gemColor((verts[a].hue + verts[b].hue) * 0.5);
        var br = depthF;
        var r = (col[0] * br) | 0;
        var g = (col[1] * br) | 0;
        var bl = (col[2] * br) | 0;

        var lw = hair * (0.9 + dmid * 1.4);
        if (lw < hair * 0.6) lw = hair * 0.6; // never sub-pixel invisible
        ctx.lineWidth = lw;
        ctx.strokeStyle = "rgba(" + r + "," + g + "," + bl + "," + alpha.toFixed(3) + ")";
        ctx.beginPath();
        ctx.moveTo(px[a], py[a]);
        ctx.lineTo(px[b], py[b]);
        ctx.stroke();
      }

      // ---- draw vertices (pin-sharp points; soft glow only for the brightest/nearest) ----
      var dprPx = hair; // ~1 device pixel in CSS units
      var glowBudget = state.maxGlow;
      for (var p = 0; p < N; p++){
        var vv = verts[p];
        var d = (pz[p] + R) / (2 * R); // 0..1 near
        if (d < 0) d = 0; else if (d > 1) d = 1;

        // slow, calm twinkle (period ~12.6s) -> no perceptible flicker over hours
        var twinkle = 0.74 + 0.26 * Math.sin(t * 0.5 + vv.ph);
        var depthF2 = 0.14 + d * d * 0.86;
        var bright = vv.base * depthF2 * twinkle;

        var col2 = gemColor(vv.hue);
        var r2 = clamp(col2[0] * bright, 0, 255) | 0;
        var g2 = clamp(col2[1] * bright, 0, 255) | 0;
        var b2 = clamp(col2[2] * bright, 0, 255) | 0;

        var x0 = px[p], y0 = py[p];

        // bright near vertices: a small soft additive glow halo (budget-capped)
        if (glowBudget > 0 && bright > 0.62 && d > 0.55){
          glowBudget--;
          var gr = dprPx * (4 + d * 6);
          var grad = ctx.createRadialGradient(x0, y0, 0, x0, y0, gr);
          grad.addColorStop(0, "rgba(" + r2 + "," + g2 + "," + b2 + "," + (0.42 * bright).toFixed(3) + ")");
          grad.addColorStop(1, "rgba(" + r2 + "," + g2 + "," + b2 + ",0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(x0, y0, gr, 0, Math.PI * 2);
          ctx.fill();
        }

        // pin-sharp core: ~1-1.5 device px square so it stays crisp
        var s = dprPx * (1.0 + d * 0.6);
        if (s < dprPx) s = dprPx; // never sub-pixel invisible
        ctx.fillStyle = "rgba(" + r2 + "," + g2 + "," + b2 + "," + clamp(bright, 0, 1).toFixed(3) + ")";
        ctx.fillRect(x0 - s * 0.5, y0 - s * 0.5, s, s);
      }

      // ---- restore clean context ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
    }
  });
})();