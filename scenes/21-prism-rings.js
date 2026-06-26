(function(){
  "use strict";

  // ---- color helpers ------------------------------------------------------
  function P3(ctx,r,g,b,a){ // r,g,b,a all 0..1
    if(a===undefined)a=1;
    if(ctx.oledWideGamut) return "color(display-p3 "+r.toFixed(4)+" "+g.toFixed(4)+" "+b.toFixed(4)+" / "+a.toFixed(4)+")";
    return "rgba("+((r*255)|0)+","+((g*255)|0)+","+((b*255)|0)+","+a.toFixed(4)+")";
  }
  function hsl2rgb(h,s,l){ // h,s,l 0..1 -> [r,g,b] 0..1
    h=((h%1)+1)%1; var c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs(((h*6)%2)-1)), m=l-c/2, r=0,g=0,b=0;
    var k=Math.floor(h*6);
    if(k===0){r=c;g=x;}else if(k===1){r=x;g=c;}else if(k===2){g=c;b=x;}else if(k===3){g=x;b=c;}else if(k===4){r=x;b=c;}else{r=c;b=x;}
    return [r+m,g+m,b+m];
  }

  // ---- tiny deterministic PRNG (mulberry32) -------------------------------
  function mulberry32(a){
    return function(){
      a|=0; a=(a+0x6D2B79F5)|0;
      var t=Math.imul(a^(a>>>15),1|a);
      t=(t+Math.imul(t^(t>>>7),61|t))^t;
      return ((t^(t>>>14))>>>0)/4294967296;
    };
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name:"Prism Rings",

    setup:function(ctx,w,h){
      if(!(w>0)) w=1; if(!(h>0)) h=1;
      var rnd = mulberry32((0x9E3779B9 ^ ((w|0)*131 + (h|0)*17)) >>> 0);
      // Slow drift oscillators for the center: a quasi-random (Lissajous-like)
      // path so the brightest near-center band never pins anywhere for long
      // and never repeats too soon. Frequencies are incommensurate.
      var c = {};
      c.ax = 0.021 + rnd()*0.012;   // x freqs (rad/s)
      c.bx = 0.013 + rnd()*0.009;
      c.ay = 0.018 + rnd()*0.011;   // y freqs
      c.by = 0.011 + rnd()*0.008;
      c.px = rnd()*Math.PI*2;       // phases
      c.qx = rnd()*Math.PI*2;
      c.py = rnd()*Math.PI*2;
      c.qy = rnd()*Math.PI*2;
      c.hueSeed = rnd();
      // how far the center wanders (frac of min dim) -- generous so the bright
      // core sweeps a large area of the panel over time (burn-in spreading)
      c.ampScale = 0.26 + rnd()*0.06;
      // a second, slower hue drift axis so the spectrum re-phases over minutes
      c.hueDrift = 0.7 + rnd()*0.6;

      return {
        c:c,
        hueSpeed: 0.05,           // wheel revolutions/sec contributed by time
        phase: rnd()*1000         // ripple phase offset so it starts mid-stream
      };
    },

    draw:function(ctx,w,h,t,dt,state){
      if(!(w>0)||!(h>0)) return;
      if(!(dt>0)) dt=0.016;
      if(dt>0.05) dt=0.05; // clamp big frame gaps

      // --- pure black background every frame (perfect OLED blacks) ---------
      ctx.globalCompositeOperation="source-over";
      ctx.globalAlpha=1;
      ctx.fillStyle="#000000";
      ctx.fillRect(0,0,w,h);

      var dpr = ctx.oledDPR || 1;
      var c = state.c;
      var minDim = Math.min(w,h);
      var cx0 = w*0.5, cy0 = h*0.5;
      var amp = minDim * c.ampScale;

      // slowly drifting center (Lissajous combination, normalized to stay in
      // frame); nothing pins for ~2-3s because the freqs are incommensurate
      var dx = (Math.sin(t*c.ax + c.px) + 0.6*Math.sin(t*c.bx + c.qx)) / 1.6;
      var dy = (Math.cos(t*c.ay + c.py) + 0.6*Math.sin(t*c.by + c.qy)) / 1.6;
      var cx = cx0 + dx*amp;
      var cy = cy0 + dy*amp;

      // radius needed to cover the whole frame from the drifting center
      var maxR = Math.hypot(Math.max(cx, w-cx), Math.max(cy, h-cy)) + 4;
      if(!(maxR>0)) return;

      // --- ripple parameters ----------------------------------------------
      // Concentric rings scroll outward; hue is set by radius (the spectrum)
      // plus a continuous time scroll, so the whole color wheel sweeps forever.
      var spacing = Math.max(26, minDim * 0.035); // px between rings
      var speed = spacing * 0.42;                  // outward px/sec
      var scroll = (t * speed) + state.phase;
      var off = scroll % spacing;                  // sub-spacing offset

      // hue: full wheel across radius (~6 rings/wheel) minus a scrolling time
      // term plus a slow re-phasing drift, so it never settles on one hue
      var huePerPx = 1.0 / (spacing * 6.0);
      var hueT = t * state.hueSpeed + 0.07*Math.sin(t*0.013*c.hueDrift);

      // hairline ~1.4 device px expressed in CSS px (crisp on supersampled buf)
      var hair = 1.4 / dpr;

      // additive blending for soft glow where halos meet
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      var rr = off;
      if(rr < 6) rr += spacing; // skip a bright dot at the very center

      var TWO_PI = Math.PI*2;
      for(; rr <= maxR; rr += spacing){
        // hue from radius (spectrum) + time scroll + slow drift
        var hue = (rr * huePerPx) - hueT + c.hueSeed;
        var rgb = hsl2rgb(hue, 1.0, 0.55); // fully saturated, mid lightness

        // Radial falloff: gently brighter toward the center but capped, with a
        // soft floor so outer rings stay visible. Kept moderate so we never
        // build a bright near-white wall and avg luminance stays low.
        var fr = rr / maxR;            // 0..1
        var fade = 1.0 - fr;
        fade = fade*0.7 + fade*fade*0.3;   // softened center weighting
        // breathing so no radius holds a constant brightness band
        var breath = 0.5 + 0.5*Math.sin(rr*0.012 - t*0.6 + c.hueSeed*6.28);
        var alpha = (0.09 + 0.34*fade) * (0.6 + 0.4*breath);
        if(alpha <= 0.004) continue;

        // crisp core hairline
        ctx.strokeStyle = P3(ctx, rgb[0], rgb[1], rgb[2], alpha);
        ctx.lineWidth = hair;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, TWO_PI);
        ctx.stroke();

        // dim, slightly wider halo for a watery glow (kept low: no bright wall)
        var halo = alpha * 0.26;
        if(halo > 0.004){
          ctx.strokeStyle = P3(ctx, rgb[0], rgb[1], rgb[2], halo);
          ctx.lineWidth = Math.max(hair*3.0, 2.2);
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, TWO_PI);
          ctx.stroke();
        }
      }

      // --- restore a clean ctx --------------------------------------------
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
    }
  });
})();