(function(){
  "use strict";

  // ---- small deterministic PRNG (mulberry32) so colors/orbs persist ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

  // hue -> rgb (h in degrees, s/l in 0..1)
  function hsl2rgb(h, s, l){
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2*l - 1)) * s;
    var x = c * (1 - Math.abs(((h/60) % 2) - 1));
    var m = l - c/2;
    var r=0,g=0,b=0;
    if (h < 60){ r=c; g=x; b=0; }
    else if (h < 120){ r=x; g=c; b=0; }
    else if (h < 180){ r=0; g=c; b=x; }
    else if (h < 240){ r=0; g=x; b=c; }
    else if (h < 300){ r=x; g=0; b=c; }
    else { r=c; g=0; b=x; }
    return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
  }

  function makeOrb(rnd, w, h, seedAbove){
    // depth 0 = far (big, dim, very blurry), 1 = near (small, bright, crisper)
    var depth = rnd();
    var o = {};
    o.depth = depth;
    o.x = rnd() * w;
    o.y = seedAbove ? (-rnd() * h * 0.5) : (rnd() * (h + h*0.4) - h*0.2);
    var minR = Math.min(w, h);
    o.r = (0.16 - depth*0.12) * minR * (0.7 + rnd()*0.7);
    o.r = clamp(o.r, minR*0.012, minR*0.22);
    // upward drift: far slow, near faster (parallax)
    o.vy = -(6 + depth*26) * (0.7 + rnd()*0.6);
    o.swayAmp = (8 + rnd()*34) * (0.4 + depth*0.8);
    o.swayFreq = 0.04 + rnd()*0.10;
    o.swayPhase = rnd() * Math.PI * 2;
    o.baseAlpha = (0.05 + depth*0.16) * (0.6 + rnd()*0.6);
    o.hue = rnd() * 360;
    o.hueDrift = (rnd() - 0.5) * 6;
    o.sat = 0.45 + rnd()*0.4;
    o.coreL = 0.55 + depth*0.18 + rnd()*0.1;
    o.twPhase = rnd() * Math.PI * 2;
    o.twFreq = 0.06 + rnd()*0.12;
    o.twAmt = 0.25 + rnd()*0.35;
    return o;
  }

  function buildGradient(ctx, o, rgb, alpha){
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, o.r);
    var cr = rgb[0], cg = rgb[1], cb = rgb[2];
    g.addColorStop(0.0, "rgba(" + cr + "," + cg + "," + cb + "," + (alpha) + ")");
    g.addColorStop(0.45, "rgba(" + cr + "," + cg + "," + cb + "," + (alpha*0.55) + ")");
    g.addColorStop(0.82, "rgba(" + cr + "," + cg + "," + cb + "," + (alpha*0.16) + ")");
    g.addColorStop(1.0, "rgba(" + cr + "," + cg + "," + cb + ",0)");
    return g;
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Bokeh Dream",

    setup: function(ctx, w, h){
      var state = {};
      // Always have a PRNG available even on the degenerate path.
      state.rnd = mulberry32(1337);
      state.hueBase = state.rnd() * 360;
      state.orbs = [];
      if (w <= 0 || h <= 0){ return state; }
      var rnd = state.rnd;
      var count = Math.round(w * h * 0.0005 * 0.16);
      count = clamp(count, 28, 110);
      var orbs = [];
      for (var i = 0; i < count; i++){
        orbs.push(makeOrb(rnd, w, h, false));
      }
      orbs.sort(function(a,b){ return a.depth - b.depth; });
      state.orbs = orbs;
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w <= 0 || h <= 0) return;
      if (!state || !state.orbs) return;
      if (!isFinite(dt) || dt < 0) dt = 0.016;
      if (dt > 0.1) dt = 0.1;
      if (!isFinite(t)) t = 0;

      // Defensive: never trust inherited canvas state from a prior scene.
      ctx.globalAlpha = 1;

      // trailing fade -> soft dreamy smear, keeps screen mostly black
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(0,0,0,0.10)";
      ctx.fillRect(0, 0, w, h);

      var orbs = state.orbs;
      var rnd = state.rnd || (state.rnd = mulberry32(1337));

      ctx.globalCompositeOperation = "lighter";

      for (var i = 0; i < orbs.length; i++){
        var o = orbs[i];

        o.y += o.vy * dt;
        o.hue += o.hueDrift * dt;

        if (o.y + o.r < -o.r * 0.2){
          var fresh = makeOrb(rnd, w, h, false);
          fresh.y = h + fresh.r + rnd() * h * 0.3;
          for (var k in fresh){ if (fresh.hasOwnProperty(k)) o[k] = fresh[k]; }
          continue;
        }

        var sway = Math.sin(t * o.swayFreq * Math.PI * 2 + o.swayPhase) * o.swayAmp;
        var px = o.x + sway;
        var py = o.y;

        if (px + o.r < 0 || px - o.r > w) continue;

        var tw = 1 + Math.sin(t * o.twFreq * Math.PI * 2 + o.twPhase) * o.twAmt;
        var alpha = clamp(o.baseAlpha * tw, 0.01, 0.6);

        var hue = o.hue + Math.sin(t * 0.05 + o.swayPhase) * 12 + state.hueBase * 0.15;
        var rgb = hsl2rgb(hue, o.sat, o.coreL);

        ctx.save();
        ctx.translate(px, py);
        ctx.fillStyle = buildGradient(ctx, o, rgb, alpha);
        ctx.beginPath();
        ctx.arc(0, 0, o.r, 0, Math.PI * 2);
        ctx.fill();

        // tiny crisp bright core for nearer / in-focus orbs only
        if (o.depth > 0.55){
          var coreR = o.r * (0.10 + (o.depth - 0.55) * 0.18);
          var ca = clamp(alpha * (0.5 + (o.depth - 0.55)), 0.02, 0.5);
          var cgr = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
          var hi = hsl2rgb(hue, o.sat * 0.5, 0.85);
          cgr.addColorStop(0, "rgba(" + hi[0] + "," + hi[1] + "," + hi[2] + "," + ca + ")");
          cgr.addColorStop(1, "rgba(" + hi[0] + "," + hi[1] + "," + hi[2] + ",0)");
          ctx.fillStyle = cgr;
          ctx.beginPath();
          ctx.arc(0, 0, coreR, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }

      // Restore canvas state so the next scene starts clean.
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  });
})();