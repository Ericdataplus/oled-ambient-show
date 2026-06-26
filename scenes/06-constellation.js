(function(){
  "use strict";

  // ---- deterministic PRNG (mulberry32) ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

  // Soft cool-techy palette: cyans, teals, soft blues, a touch of violet.
  // Returned as [r,g,b] 0-255.
  function nodeColor(rand){
    var p = rand();
    if (p < 0.45) return [120, 210, 255];      // cyan-blue
    if (p < 0.75) return [110, 255, 230];       // teal/aqua
    if (p < 0.92) return [180, 200, 255];       // soft periwinkle
    return [200, 170, 255];                      // gentle violet
  }

  // ---- link helpers (hoisted to IIFE scope so they are NOT recreated per frame) ----
  function linkPair(c2, a2, b2, ld2, ld){
    var dx = a2.x - b2.x;
    var dy = a2.y - b2.y;
    var d2 = dx * dx + dy * dy;
    if (d2 >= ld2) return;
    var d = Math.sqrt(d2);
    var prox = 1 - d / ld;            // 0..1 closeness
    // opacity by proximity, modulated by both nodes' twinkle
    var op = prox * prox * 0.45 * (0.45 + 0.55 * ((a2.tw + b2.tw) * 0.5));
    if (op < 0.004) return;
    // blend color between the two endpoints
    var r = (a2.r + b2.r) * 0.5;
    var g2 = (a2.g + b2.g) * 0.5;
    var bb = (a2.b + b2.b) * 0.5;
    c2.strokeStyle = "rgba(" + (r | 0) + "," + (g2 | 0) + "," + (bb | 0) + "," + op.toFixed(3) + ")";
    c2.beginPath();
    c2.moveTo(a2.x, a2.y);
    c2.lineTo(b2.x, b2.y);
    c2.stroke();
  }

  function tryNeighbor(c2, g, cl, rw, ccx, ccy, aNode, nds, ld2, ld){
    if (ccx < 0 || ccx >= cl || ccy < 0 || ccy >= rw) return;
    var bk = g[ccy * cl + ccx];
    for (var z = 0; z < bk.length; z++){
      linkPair(c2, aNode, nds[bk[z]], ld2, ld);
    }
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Constellation Network",

    setup: function(ctx, w, h){
      var state = {};
      if (w <= 0 || h <= 0){ state.nodes = []; return state; }

      var rand = mulberry32(1337 ^ ((w * 73856093) ^ (h * 19349663)));
      state.rand = rand;

      // Count scales with area, clamped for performance.
      var area = w * h;
      var count = Math.round(area * 0.00018);
      count = clamp(count, 60, 220);

      var diag = Math.sqrt(w * w + h * h);

      // Build field on an oversized canvas so rotation never reveals edges.
      // We position nodes relative to center, within a radius larger than half-diag.
      var fieldR = diag * 0.62;

      var nodes = new Array(count);
      for (var i = 0; i < count; i++){
        // uniform-ish disc sampling
        var ang = rand() * Math.PI * 2;
        var rr = Math.sqrt(rand()) * fieldR;
        var col = nodeColor(rand);
        nodes[i] = {
          // base position (in centered, unrotated field space)
          bx: Math.cos(ang) * rr,
          by: Math.sin(ang) * rr,
          // slow individual drift parameters
          dphase: rand() * Math.PI * 2,
          dphase2: rand() * Math.PI * 2,
          dspeed: 0.05 + rand() * 0.12,
          dspeed2: 0.04 + rand() * 0.10,
          damp: 14 + rand() * 26,           // drift amplitude (px)
          // twinkle
          tphase: rand() * Math.PI * 2,
          tspeed: 0.4 + rand() * 1.1,
          baseSize: 0.9 + rand() * 1.8,
          r: col[0], g: col[1], b: col[2],
          // live transformed coords (filled each frame)
          x: 0, y: 0, tw: 0
        };
      }

      state.nodes = nodes;
      state.fieldR = fieldR;
      // link distance threshold scales with density so the web stays balanced
      var density = count / area;
      state.linkDist = clamp(1.0 / Math.sqrt(density) * 1.9, 80, 230);
      state.linkDist2 = state.linkDist * state.linkDist;

      // Spatial grid cell == link distance (complete neighbor coverage with same+4 cells).
      state.cell = state.linkDist;
      state._grid = null; // (re)built lazily in draw

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0 || !state.nodes || state.nodes.length === 0) return;

      var nodes = state.nodes;
      var n = nodes.length;
      var cx = w * 0.5, cy = h * 0.5;

      // Motion trail: faint fade keeps lines feeling alive, very dark average.
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(0, 0, w, h);

      // Slow global rotation + gentle breathing drift of the whole field.
      var rot = t * 0.012;                       // ~radians/sec, very slow
      var cosR = Math.cos(rot), sinR = Math.sin(rot);
      var driftX = Math.sin(t * 0.05) * (w * 0.03);
      var driftY = Math.cos(t * 0.037) * (h * 0.03);

      // ---- update live positions ----
      for (var i = 0; i < n; i++){
        var nd = nodes[i];
        // individual organic drift in field space
        var ox = Math.cos(nd.dphase + t * nd.dspeed) * nd.damp;
        var oy = Math.sin(nd.dphase2 + t * nd.dspeed2) * nd.damp;
        var fx = nd.bx + ox;
        var fy = nd.by + oy;
        // rotate field
        var rxx = fx * cosR - fy * sinR;
        var ryy = fx * sinR + fy * cosR;
        nd.x = cx + rxx + driftX;
        nd.y = cy + ryy + driftY;
        // twinkle 0..1 smooth
        nd.tw = 0.5 + 0.5 * Math.sin(nd.tphase + t * nd.tspeed);
      }

      // ---- build spatial grid in screen space (only visible-ish region) ----
      var cell = state.cell;
      var pad = cell; // extra margin
      var minX = -pad, minY = -pad;
      var cols = Math.max(1, Math.ceil((w + 2 * pad) / cell));
      var rows = Math.max(1, Math.ceil((h + 2 * pad) / cell));
      var grid = state._grid;
      if (!grid || grid.length !== cols * rows){
        grid = new Array(cols * rows);
        for (var gi = 0; gi < grid.length; gi++) grid[gi] = [];
        state._grid = grid;
      } else {
        for (var gj = 0; gj < grid.length; gj++) grid[gj].length = 0;
      }

      for (var p = 0; p < n; p++){
        var pn = nodes[p];
        if (pn.x < -pad || pn.x > w + pad || pn.y < -pad || pn.y > h + pad) continue;
        var c = Math.floor((pn.x - minX) / cell);
        var rr2 = Math.floor((pn.y - minY) / cell);
        if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
        if (rr2 < 0) rr2 = 0; else if (rr2 >= rows) rr2 = rows - 1;
        grid[rr2 * cols + c].push(p);
      }

      var linkDist = state.linkDist;
      var linkDist2 = state.linkDist2;

      // ---- draw links (additive) ----
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1;

      for (var ry = 0; ry < rows; ry++){
        for (var rxC = 0; rxC < cols; rxC++){
          var bucket = grid[ry * cols + rxC];
          if (bucket.length === 0) continue;
          // check this cell + neighbors (right, down, down-left, down-right) to avoid dupes
          for (var bi = 0; bi < bucket.length; bi++){
            var ai = bucket[bi];
            var a = nodes[ai];

            // same-cell pairs
            for (var bj = bi + 1; bj < bucket.length; bj++){
              linkPair(ctx, a, nodes[bucket[bj]], linkDist2, linkDist);
            }
            // neighbor cells (offsets that avoid double counting)
            tryNeighbor(ctx, grid, cols, rows, rxC + 1, ry,     a, nodes, linkDist2, linkDist);
            tryNeighbor(ctx, grid, cols, rows, rxC - 1, ry + 1, a, nodes, linkDist2, linkDist);
            tryNeighbor(ctx, grid, cols, rows, rxC,     ry + 1, a, nodes, linkDist2, linkDist);
            tryNeighbor(ctx, grid, cols, rows, rxC + 1, ry + 1, a, nodes, linkDist2, linkDist);
          }
        }
      }

      // ---- draw nodes (glow) ----
      for (var k = 0; k < n; k++){
        var node = nodes[k];
        if (node.x < -20 || node.x > w + 20 || node.y < -20 || node.y > h + 20) continue;
        var tw = node.tw;
        var size = node.baseSize * (0.7 + tw * 0.9);
        var glow = size * (4.2 + tw * 3.0);

        // soft halo
        var ga = 0.10 + tw * 0.22;
        var grad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glow);
        grad.addColorStop(0, "rgba(" + node.r + "," + node.g + "," + node.b + "," + ga.toFixed(3) + ")");
        grad.addColorStop(0.4, "rgba(" + node.r + "," + node.g + "," + node.b + "," + (ga * 0.4).toFixed(3) + ")");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(node.x, node.y, glow, 0, Math.PI * 2);
        ctx.fill();

        // bright core
        var ca = 0.45 + tw * 0.45;
        ctx.fillStyle = "rgba(" + node.r + "," + node.g + "," + node.b + "," + ca.toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- restore state so the next scene starts clean ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  });
})();