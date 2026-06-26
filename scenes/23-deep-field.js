(function(){ "use strict";

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

  // small value-noise for very-slow background nebulosity drift seed
  function hash2(x, y, s){
    var h = Math.sin(x * 127.1 + y * 311.7 + s * 53.13) * 43758.5453;
    return h - Math.floor(h);
  }

  function dpx(ctx){
    var d = ctx.oledDPR;
    return (d && d > 0) ? (1 / d) : 0.6;
  }

  // ---- color helpers (galaxy palette: warm golds, cool blues, faint reds) ----
  // returns {r,g,b} 0..255 for core/disk tints, restrained
  function galaxyColor(rng){
    var roll = rng();
    if (roll < 0.42){
      // cool blue-white (younger / spiral)
      return { r: 165 + rng()*55, g: 185 + rng()*45, b: 230 + rng()*25 };
    } else if (roll < 0.78){
      // warm gold / amber (elliptical, redshifted)
      return { r: 230 + rng()*25, g: 195 + rng()*35, b: 140 + rng()*40 };
    } else if (roll < 0.93){
      // faint dusty red (very distant)
      return { r: 220 + rng()*30, g: 130 + rng()*40, b: 110 + rng()*35 };
    } else {
      // neutral pale
      return { r: 210 + rng()*30, g: 210 + rng()*30, b: 205 + rng()*30 };
    }
  }

  function starColor(rng){
    var roll = rng();
    if (roll < 0.68){
      return { r: 200 + rng()*40, g: 215 + rng()*35, b: 245 + rng()*10 }; // blue-white
    } else if (roll < 0.88){
      return { r: 250, g: 245 + rng()*8, b: 225 + rng()*20 }; // white-yellow
    } else {
      return { r: 252, g: 205 + rng()*30, b: 160 + rng()*40 }; // warm
    }
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Deep Field",

    setup: function(ctx, w, h){
      var state = {};
      if (w <= 0 || h <= 0){ state.bad = true; return state; }

      var rng = mulberry32(0x9E3779B1 ^ ((w*73856093) ^ (h*19349663)));
      state.rng = rng;

      var area = w * h;
      var areaScale = clamp(area / (1920 * 1080), 0.35, 2.4);

      // ----- field uses a normalized "universe" space larger than screen so
      // we can drift & slow-zoom and have new galaxies ease in. -----
      // Galaxies live in u-space [-0.6 .. 1.6] x [-0.6 .. 1.6] (aspect adjusted by draw)
      var GAL = Math.round(520 * areaScale);
      GAL = clamp(GAL, 180, 1100);

      var galaxies = new Array(GAL);
      for (var i = 0; i < GAL; i++){
        var c = galaxyColor(rng);
        var typeRoll = rng();
        var isSpiral = typeRoll < 0.40;
        var isEdge = !isSpiral && typeRoll < 0.62; // edge-on lenticular sliver
        // size in CSS px (at zoom=1); mostly small distant smudges
        var sz = 2.0 + Math.pow(rng(), 2.6) * 26.0;
        var hasCore = rng() < 0.30;
        galaxies[i] = {
          ux: -0.6 + rng() * 2.2,
          uy: -0.6 + rng() * 2.2,
          depth: 0.35 + rng() * 0.65,      // parallax: nearer = bigger drift
          size: sz,
          ell: 0.45 + rng() * 0.5,         // axis ratio
          rot: rng() * Math.PI,
          r: c.r, g: c.g, b: c.b,
          baseA: 0.05 + rng() * 0.16,
          spiral: isSpiral,
          edge: isEdge,
          core: hasCore,
          coreA: 0.25 + rng() * 0.5,
          twk: 0.4 + rng() * 1.4,          // gentle brightness breathing rate
          twph: rng() * Math.PI * 2
        };
      }
      state.galaxies = galaxies;

      // ----- foreground sharp stars (fewer) -----
      var STAR = Math.round(260 * areaScale);
      STAR = clamp(STAR, 110, 600);
      var stars = new Array(STAR);
      for (var s = 0; s < STAR; s++){
        var sc = starColor(rng);
        var bright = Math.pow(rng(), 3.2); // most faint, few bright
        stars[s] = {
          ux: -0.6 + rng() * 2.2,
          uy: -0.6 + rng() * 2.2,
          depth: 0.7 + rng() * 0.55,
          mag: bright,                      // 0..1
          r: sc.r, g: sc.g, b: sc.b,
          spike: bright > 0.82 && rng() < 0.6,
          twk: 0.3 + rng() * 1.1,
          twph: rng() * Math.PI * 2,
          size: 0.6 + bright * 1.7
        };
      }
      state.stars = stars;

      // ----- faint nebulosity blobs (large, low alpha, additive) -----
      var NEB = clamp(Math.round(7 * areaScale), 4, 14);
      var nebs = new Array(NEB);
      for (var n = 0; n < NEB; n++){
        var nc = galaxyColor(rng); // reuse palette but very dim
        nebs[n] = {
          ux: -0.3 + rng() * 1.6,
          uy: -0.3 + rng() * 1.6,
          rad: (0.20 + rng() * 0.35),       // fraction of min(w,h)
          r: nc.r, g: nc.g, b: nc.b,
          a: 0.012 + rng() * 0.022,
          drx: (rng() - 0.5) * 0.006,
          dry: (rng() - 0.5) * 0.006,
          pr: 0.05 + rng() * 0.12,          // pulse rate
          pph: rng() * Math.PI * 2
        };
      }
      state.nebs = nebs;

      state.w = w; state.h = h;
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (!state || state.bad || w <= 0 || h <= 0) return;
      dt = clamp(dt || 0, 0, 0.05);

      // true black background every frame
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);

      var px = dpx(ctx);
      var minDim = Math.min(w, h);

      // ---- global slow drift + breathing zoom so nothing pins ----
      // slow pan across the field
      var panX = Math.sin(t * 0.011) * 0.10 + t * 0.0028;
      var panY = Math.cos(t * 0.009) * 0.085 + Math.sin(t * 0.004) * 0.03;
      // very slow zoom oscillation (galaxies ease in/out)
      var zoom = 1.0 + 0.14 * Math.sin(t * 0.013) + 0.06 * Math.sin(t * 0.031 + 1.3);
      // whole-field micro rotation
      var rot = Math.sin(t * 0.006) * 0.05;
      var cosR = Math.cos(rot), sinR = Math.sin(rot);

      var cx = w * 0.5, cy = h * 0.5;

      // map u-space (0..1 in min-dim units, centered) to screen
      // wrap pan so field is seamless
      function wrapU(u){
        // keep within a repeating window so galaxies recycle
        var p = u % 2.2;
        if (p < -0.6) p += 2.2;
        if (p > 1.6) p -= 2.2;
        return p;
      }

      // Convert a galaxy/star u-coordinate to screen, applying parallax depth
      // Returns null-ish via flags; we just compute inline.

      // ---------- 1. Nebulosity (additive, very faint) ----------
      ctx.globalCompositeOperation = "lighter";
      for (var ni = 0; ni < state.nebs.length; ni++){
        var nb = state.nebs[ni];
        var nux = wrapU(nb.ux + panX * 0.25 + nb.drx * t);
        var nuy = wrapU(nb.uy + panY * 0.25 + nb.dry * t);
        // center-relative, scaled by minDim and zoom
        var nx0 = (nux - 0.5) * minDim;
        var ny0 = (nuy - 0.5) * minDim;
        var nx = cx + (nx0 * cosR - ny0 * sinR) * zoom;
        var ny = cy + (nx0 * sinR + ny0 * cosR) * zoom;
        var nrad = nb.rad * minDim * zoom;
        if (nrad <= 0) continue;
        var pulse = 0.78 + 0.22 * Math.sin(t * nb.pr + nb.pph);
        var na = nb.a * pulse;
        var grd = ctx.createRadialGradient(nx, ny, 0, nx, ny, nrad);
        grd.addColorStop(0, "rgba(" + (nb.r|0) + "," + (nb.g|0) + "," + (nb.b|0) + "," + na.toFixed(4) + ")");
        grd.addColorStop(0.45, "rgba(" + (nb.r|0) + "," + (nb.g|0) + "," + (nb.b|0) + "," + (na*0.4).toFixed(4) + ")");
        grd.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(nx, ny, nrad, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---------- 2. Galaxies (additive smudges) ----------
      var gals = state.galaxies;
      for (var gi = 0; gi < gals.length; gi++){
        var gx = gals[gi];
        // parallax: depth scales drift
        var gux = wrapU(gx.ux + panX * gx.depth);
        var guy = wrapU(gx.uy + panY * gx.depth);
        var gx0 = (gux - 0.5) * minDim;
        var gy0 = (guy - 0.5) * minDim;
        var sx = cx + (gx0 * cosR - gy0 * sinR) * zoom;
        var sy = cy + (gx0 * sinR + gy0 * cosR) * zoom;

        var gsize = gx.size * zoom * (0.7 + gx.depth * 0.5);
        if (gsize < 0.5) continue;
        // cull offscreen
        if (sx < -gsize*2 || sx > w + gsize*2 || sy < -gsize*2 || sy > h + gsize*2) continue;

        var breathe = 0.85 + 0.15 * Math.sin(t * gx.twk * 0.5 + gx.twph);
        var alpha = gx.baseA * breathe;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(gx.rot + rot);

        if (gx.edge){
          // edge-on sliver: thin elongated glow
          var elen = gsize * 1.6;
          var ethk = gsize * 0.22;
          var eg = ctx.createRadialGradient(0, 0, 0, 0, 0, elen);
          eg.addColorStop(0, "rgba(" + (gx.r|0) + "," + (gx.g|0) + "," + (gx.b|0) + "," + (alpha*1.4).toFixed(4) + ")");
          eg.addColorStop(0.5, "rgba(" + (gx.r|0) + "," + (gx.g|0) + "," + (gx.b|0) + "," + (alpha*0.5).toFixed(4) + ")");
          eg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = eg;
          ctx.save();
          ctx.scale(1, ethk / elen);
          ctx.beginPath();
          ctx.arc(0, 0, elen, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          // elliptical / spiral soft glow
          ctx.scale(1, gx.ell);
          var rg = ctx.createRadialGradient(0, 0, 0, 0, 0, gsize);
          rg.addColorStop(0, "rgba(" + (gx.r|0) + "," + (gx.g|0) + "," + (gx.b|0) + "," + (alpha*1.5).toFixed(4) + ")");
          rg.addColorStop(0.4, "rgba(" + (gx.r|0) + "," + (gx.g|0) + "," + (gx.b|0) + "," + (alpha*0.55).toFixed(4) + ")");
          rg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(0, 0, gsize, 0, Math.PI * 2);
          ctx.fill();

          if (gx.spiral && gsize > 4){
            // faint inner concentration to suggest a disk + slightly tighter glow
            var ig = ctx.createRadialGradient(0, 0, 0, 0, 0, gsize * 0.5);
            ig.addColorStop(0, "rgba(" + (gx.r|0) + "," + (gx.g|0) + "," + (gx.b|0) + "," + (alpha*1.1).toFixed(4) + ")");
            ig.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = ig;
            ctx.beginPath();
            ctx.arc(0, 0, gsize * 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();

        // tiny bright core (a few)
        if (gx.core && gsize > 2.2){
          var cr = Math.max(px, gsize * 0.08);
          var ca = gx.coreA * breathe;
          var cg = ctx.createRadialGradient(sx, sy, 0, sx, sy, cr * 3);
          cg.addColorStop(0, "rgba(255,250,240," + (ca).toFixed(4) + ")");
          cg.addColorStop(0.5, "rgba(" + (gx.r|0) + "," + (gx.g|0) + "," + (gx.b|0) + "," + (ca*0.4).toFixed(4) + ")");
          cg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = cg;
          ctx.beginPath();
          ctx.arc(sx, sy, cr * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ---------- 3. Foreground sharp stars (additive) ----------
      var stars = state.stars;
      for (var si = 0; si < stars.length; si++){
        var st = stars[si];
        var sux = wrapU(st.ux + panX * st.depth);
        var suy = wrapU(st.uy + panY * st.depth);
        var sx0 = (sux - 0.5) * minDim;
        var sy0 = (suy - 0.5) * minDim;
        var px2 = cx + (sx0 * cosR - sy0 * sinR) * zoom;
        var py2 = cy + (sx0 * sinR + sy0 * cosR) * zoom;
        if (px2 < -8 || px2 > w + 8 || py2 < -8 || py2 > h + 8) continue;

        var tw = 0.78 + 0.22 * Math.sin(t * st.twk + st.twph);
        var mag = st.mag * tw;
        var pr = Math.max(px, st.size * px / 0.6 * (0.6 + st.depth * 0.3));
        // crisp pinpoint core
        var coreA = clamp(0.22 + mag * 0.78, 0, 1);

        // soft halo
        var halR = pr * (3 + mag * 5);
        var hg = ctx.createRadialGradient(px2, py2, 0, px2, py2, halR);
        hg.addColorStop(0, "rgba(" + (st.r|0) + "," + (st.g|0) + "," + (st.b|0) + "," + (mag*0.5).toFixed(4) + ")");
        hg.addColorStop(0.3, "rgba(" + (st.r|0) + "," + (st.g|0) + "," + (st.b|0) + "," + (mag*0.16).toFixed(4) + ")");
        hg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.arc(px2, py2, halR, 0, Math.PI * 2);
        ctx.fill();

        // sharp center
        ctx.fillStyle = "rgba(" + (st.r|0) + "," + (st.g|0) + "," + (st.b|0) + "," + coreA.toFixed(4) + ")";
        ctx.beginPath();
        ctx.arc(px2, py2, pr, 0, Math.PI * 2);
        ctx.fill();

        // subtle diffraction spikes on the few brightest
        if (st.spike){
          var spA = mag * 0.32;
          var spLen = pr * (8 + mag * 10);
          ctx.strokeStyle = "rgba(" + (st.r|0) + "," + (st.g|0) + "," + (st.b|0) + "," + spA.toFixed(4) + ")";
          ctx.lineWidth = px;
          ctx.beginPath();
          ctx.moveTo(px2 - spLen, py2); ctx.lineTo(px2 + spLen, py2);
          ctx.moveTo(px2, py2 - spLen); ctx.lineTo(px2, py2 + spLen);
          ctx.stroke();
        }
      }

      // ---- reset ctx clean ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
  });

})();