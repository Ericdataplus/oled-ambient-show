(function(){
  "use strict";

  // ---- helpers (all inside IIFE) ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function lerp(a,b,k){ return a+(b-a)*k; }

  // Moonlit silver-blue palette (kept low; additive blending will brighten where it overlaps)
  // returns "r,g,b" string for a given tint 0..1 (0 = cool blue, 1 = silvery white)
  function tint(k){
    var r = Math.round(lerp(120, 205, k));
    var g = Math.round(lerp(165, 220, k));
    var b = Math.round(lerp(225, 245, k));
    return r + "," + g + "," + b;
  }

  // Spawn a ripple from the reusable pool (hoisted to IIFE scope: no per-frame closure alloc)
  function spawnRipple(st, x, y, tone, bright){
    var pool = st.ripples;
    for (var p = 0; p < pool.length; p++){
      if (!pool[p].active){
        var rr = pool[p];
        rr.active = true;
        rr.x = x; rr.y = y;
        rr.age = 0;
        rr.life = lerp(3.2, 5.5, st.rng());
        rr.maxR = lerp(60, 160, st.rng());
        rr.tone = tone;
        rr.strength = clamp(bright * lerp(0.45, 0.8, st.rng()), 0.08, 0.5);
        rr.rings = 3 + (st.rng() < 0.5 ? 0 : 1);
        return;
      }
    }
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Rain & Ripples",

    setup: function(ctx, w, h){
      var state = {};
      if (w <= 0 || h <= 0) { state.bad = true; return state; }
      state.bad = false;

      var rng = mulberry32(0x9E3779B1 ^ (w*131 + h*977));
      state.rng = rng;
      state.w = w; state.h = h;

      // Scale streak count by area, clamped.
      var area = w * h;
      var nStreaks = clamp(Math.round(area * 0.00009), 40, 150);

      // Persistent falling streaks. Each has fixed x and speed; phase wraps.
      var streaks = new Array(nStreaks);
      for (var i = 0; i < nStreaks; i++){
        streaks[i] = {
          x: rng() * w,
          phase: rng(),                       // 0..1 vertical progress
          speed: lerp(0.10, 0.26, rng()),     // progress per second (slow, calm)
          len: lerp(0.10, 0.26, rng()) * h,   // streak length in px
          thick: lerp(0.7, 1.8, rng()),       // px wide
          bright: lerp(0.18, 0.55, rng()),    // base brightness
          tone: rng(),                         // color tint
          // when this streak completes a fall, decide if it "lands" (spawns a ripple)
          landRoll: rng()
        };
      }
      state.streaks = streaks;

      // Ripple pool (reused, no per-frame allocation)
      var maxRipples = 60;
      var ripples = new Array(maxRipples);
      for (var j = 0; j < maxRipples; j++){
        ripples[j] = { active:false, x:0, y:0, age:0, life:1, maxR:1, tone:0, strength:0, rings:3 };
      }
      state.ripples = ripples;
      state.maxRipples = maxRipples;

      // Water line region: ripples live in the lower portion (like a dark pond surface)
      state.waterTop = h * 0.42;

      // Slow shimmer offset for the water sheen
      state.shimmer = rng() * 1000;

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if (!state || state.bad || w <= 0 || h <= 0) return;
      if (dt > 0.1) dt = 0.1; // guard against spikes

      var streaks = state.streaks;
      var ripples = state.ripples;
      var waterTop = state.waterTop;

      // --- Background: near-true-black with a very subtle vertical moon wash (low lum) ---
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      // faint cool gradient on the water surface to suggest depth (kept very dark)
      var bgGrad = ctx.createLinearGradient(0, waterTop, 0, h);
      bgGrad.addColorStop(0, "rgba(10,16,26,0.0)");
      bgGrad.addColorStop(1, "rgba(8,14,24,0.35)");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, waterTop, w, h - waterTop);

      // additive glow from here on
      ctx.globalCompositeOperation = "lighter";

      // --- Falling rain streaks ---
      var i, s, x, alpha, col, grad;
      for (i = 0; i < streaks.length; i++){
        s = streaks[i];
        s.phase += s.speed * dt;

        if (s.phase >= 1){
          // streak finished its fall -> wraps; possibly spawn a ripple where it "lands"
          s.phase -= 1;
          // re-randomize x slightly so columns don't burn-in
          s.x = (s.x + lerp(-40, 40, state.rng()) + w) % w;
          s.landRoll = state.rng();
          if (s.landRoll < 0.55){
            spawnRipple(state, s.x, waterTop + state.rng() * (h - waterTop), s.tone, s.bright);
          }
        }

        x = s.x;
        // streak occupies a window of vertical travel down to the water line
        var travel = waterTop + s.len; // it fades as it reaches water
        var headY = s.phase * travel;
        var yTop = headY - s.len;
        var yBot = headY;

        // fade out as it nears/enters the water surface
        var enter = clamp((headY - (waterTop - s.len)) / s.len, 0, 1);
        var fade = 1 - enter * 0.9;
        if (fade <= 0.02) continue;

        alpha = s.bright * fade;
        col = tint(s.tone);

        grad = ctx.createLinearGradient(x, yTop, x, yBot);
        grad.addColorStop(0,   "rgba(" + col + ",0)");
        grad.addColorStop(0.7, "rgba(" + col + "," + (alpha * 0.5).toFixed(3) + ")");
        grad.addColorStop(1,   "rgba(" + col + "," + alpha.toFixed(3) + ")");
        ctx.fillStyle = grad;
        ctx.fillRect(x - s.thick * 0.5, yTop, s.thick, yBot - yTop);

        // tiny soft head highlight
        var hr = s.thick * 1.8;
        var hg = ctx.createRadialGradient(x, yBot, 0, x, yBot, hr);
        hg.addColorStop(0, "rgba(" + col + "," + (alpha * 0.8).toFixed(3) + ")");
        hg.addColorStop(1, "rgba(" + col + ",0)");
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.arc(x, yBot, hr, 0, Math.PI * 2);
        ctx.fill();
      }

      // --- Ripples (expanding concentric fading rings) ---
      var r, k, ringR, ringAlpha, rc;
      for (i = 0; i < ripples.length; i++){
        r = ripples[i];
        if (!r.active) continue;
        r.age += dt;
        var lifeK = r.age / r.life;
        if (lifeK >= 1){ r.active = false; continue; }

        rc = tint(r.tone);
        // overall envelope: rise quickly, fall slowly
        var env = Math.sin(Math.min(lifeK, 1) * Math.PI);
        env = env * env; // softer

        var baseR = lifeK * r.maxR;

        ctx.lineWidth = 1.2;
        for (k = 0; k < r.rings; k++){
          // each ring trails behind the leading edge
          ringR = baseR - k * (r.maxR * 0.14);
          if (ringR <= 0) continue;
          // rings thin out and fade with k and as they expand
          ringAlpha = r.strength * env * (1 - k / (r.rings + 0.5)) * (1 - lifeK * 0.6);
          if (ringAlpha <= 0.01) continue;

          // squash vertically a touch to feel like a surface viewed at an angle
          ctx.save();
          ctx.translate(r.x, r.y);
          ctx.scale(1, 0.46);
          ctx.strokeStyle = "rgba(" + rc + "," + ringAlpha.toFixed(3) + ")";
          ctx.beginPath();
          ctx.arc(0, 0, ringR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        // soft central glint at impact, fades fast
        if (lifeK < 0.35){
          var gA = r.strength * (1 - lifeK / 0.35) * 0.6;
          var gr = 6 + lifeK * 14;
          var cg = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, gr);
          cg.addColorStop(0, "rgba(" + rc + "," + gA.toFixed(3) + ")");
          cg.addColorStop(1, "rgba(" + rc + ",0)");
          ctx.fillStyle = cg;
          ctx.save();
          ctx.translate(r.x, r.y);
          ctx.scale(1, 0.5);
          ctx.beginPath();
          ctx.arc(0, 0, gr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // --- gentle moving shimmer on the water (low brightness, always drifting -> no burn-in) ---
      var sh = state.shimmer + t * 0.08;
      var bands = 3;
      for (i = 0; i < bands; i++){
        var by = waterTop + ((h - waterTop) * (0.25 + 0.25 * i));
        var off = Math.sin(sh + i * 2.1) * (w * 0.18);
        var cx = w * 0.5 + off;
        var rad = w * 0.5;
        var sg = ctx.createRadialGradient(cx, by, 0, cx, by, rad);
        var sa = 0.05 * (1 - i * 0.25);
        sg.addColorStop(0, "rgba(150,180,225," + sa.toFixed(3) + ")");
        sg.addColorStop(1, "rgba(150,180,225,0)");
        ctx.fillStyle = sg;
        ctx.save();
        ctx.translate(cx, by);
        ctx.scale(1, 0.18);
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // reset state so the next scene starts clean
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
  });
})();