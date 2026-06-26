(function(){ "use strict";

  function P3(ctx,r,g,b,a){
    if(a===undefined)a=1;
    if(ctx.oledWideGamut) return "color(display-p3 "+r.toFixed(4)+" "+g.toFixed(4)+" "+b.toFixed(4)+" / "+a.toFixed(4)+")";
    return "rgba("+((r*255)|0)+","+((g*255)|0)+","+((b*255)|0)+","+a.toFixed(4)+")";
  }
  function hsl2rgb(h,s,l){
    h=((h%1)+1)%1; var c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs(((h*6)%2)-1)), m=l-c/2, r=0,g=0,b=0;
    var k=Math.floor(h*6);
    if(k===0){r=c;g=x;}else if(k===1){r=x;g=c;}else if(k===2){g=c;b=x;}else if(k===3){g=x;b=c;}else if(k===4){r=x;b=c;}else{r=c;b=x;}
    return [r+m,g+m,b+m];
  }

  // small fast PRNG (mulberry32)
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
    name:"Spectral Veil",

    setup:function(ctx,w,h){
      if(w<=0||h<=0) return {curtains:[], n:0, seg:1};
      var rnd = mulberry32(0x5A17C0DE);

      // Number of curtains scaled gently to width, capped for perf.
      var n = Math.max(28, Math.min(72, Math.round(w/26)));

      var curtains = [];
      for(var i=0;i<n;i++){
        curtains.push({
          // base horizontal position as fraction 0..1, evenly-ish spread + jitter
          base:(i+0.5)/n + (rnd()-0.5)*(0.6/n),
          // per-curtain wave params
          ampA: 18 + rnd()*70,           // sway amplitude px
          ampB: 6 + rnd()*30,
          freqA: 0.5 + rnd()*1.4,        // vertical wave frequency
          freqB: 1.2 + rnd()*3.0,
          spdA: 0.06 + rnd()*0.16,       // temporal drift speeds
          spdB: 0.10 + rnd()*0.30,
          phaseA: rnd()*Math.PI*2,
          phaseB: rnd()*Math.PI*2,
          // breathing of intensity & width
          breathSpd: 0.05 + rnd()*0.13,
          breathPh: rnd()*Math.PI*2,
          width: 1.0 + rnd()*2.2,        // core striation width (device px units later)
          glow: 10 + rnd()*30,           // soft glow half-width in px
          hueOff: rnd()*0.12,            // slight per-curtain hue offset for richness
          lum: 0.40 + rnd()*0.14         // mid lightness (kept mid, never near 1)
        });
      }

      return {
        curtains:curtains,
        n:n,
        seg: 22,            // vertical segments per curtain (resolution of the wave)
        drift: 0,           // slow global drift accumulator
        px: new Float32Array((22+1)*2)   // reusable point buffer (no per-frame alloc)
      };
    },

    draw:function(ctx,w,h,t,dt,state){
      if(w<=0||h<=0) return;
      // Robust dt clamp (NaN / negative / zero / huge).
      if(!(dt>0)) dt=0.016;
      if(dt>0.05) dt=0.05;

      var dpr = ctx.oledDPR || 1;

      // True black background every frame (no trails => pure black majority, no static accumulation).
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0,0,w,h);

      var cs = state.curtains;
      if(!cs || !cs.length) return;

      // Slow global horizontal drift so nothing pins in place (burn-in protection).
      state.drift += dt*0.012;
      var globalDrift = Math.sin(state.drift)*0.05; // fraction of width, gentle

      // Overall hue sweep across full wheel over time; spatial term spreads spectrum across width.
      var hueTime = t*0.035;          // continuous full-wheel cycle (~28s)
      var hueSpan = 1.0;              // one full rainbow across the screen width

      var seg = state.seg;
      var invSeg = 1/seg;
      var px = state.px;
      if(!px || px.length < (seg+1)*2){ px = state.px = new Float32Array((seg+1)*2); }

      // Additive blending for glow stacking; mid lightness keeps it from blowing out.
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      var oneDevPx = 1/dpr;
      var TWO_PI = Math.PI*2;

      for(var i=0;i<cs.length;i++){
        var c = cs[i];

        // breathing intensity ~0.22..1 (keeps lots of black, prevents a bright wall)
        var breathe = 0.5 + 0.5*Math.sin(t*c.breathSpd*TWO_PI + c.breathPh);
        var intensity = 0.22 + breathe*0.78;

        // horizontal center fraction with global drift
        var frac = c.base + globalDrift;
        // hue for this curtain: spatial position around wheel + time + tiny per-curtain offset
        var baseHue = frac*hueSpan + hueTime + c.hueOff;

        // Build wavy vertical path into the reusable buffer.
        var fwA = c.ampA, fwB = c.ampB;
        var pa = c.freqA, pb = c.freqB;
        var ta = t*c.spdA*TWO_PI + c.phaseA;
        var tb = t*c.spdB*TWO_PI + c.phaseB;
        var fracW = frac*w;
        for(var s=0;s<=seg;s++){
          var yf = s*invSeg;          // 0..1 top->bottom
          var y = yf*h;
          var wav =
            Math.sin(yf*TWO_PI*pa + ta)*fwA +
            Math.sin(yf*TWO_PI*pb + tb)*fwB;
          var idx = s*2;
          px[idx]   = fracW + wav;
          px[idx+1] = y;
        }
        var lastIdx = seg*2;

        // --- soft glow pass (one stroke, wide, low alpha) ---
        var glowW = c.glow * intensity;
        if(glowW < 2) glowW = 2;
        var rgbG = hsl2rgb(baseHue, 1.0, c.lum*0.50);
        ctx.lineWidth = glowW;
        ctx.strokeStyle = P3(ctx, rgbG[0], rgbG[1], rgbG[2], 0.05*intensity);
        ctx.beginPath();
        ctx.moveTo(px[0], px[1]);
        for(var p=2;p<=lastIdx;p+=2){ ctx.lineTo(px[p], px[p+1]); }
        ctx.stroke();

        // --- mid glow pass (tighter, slightly brighter, slightly hue-shifted) ---
        var midW = glowW*0.45;
        if(midW < 1.5) midW = 1.5;
        var rgbM = hsl2rgb(baseHue + 0.02, 1.0, c.lum*0.75);
        ctx.lineWidth = midW;
        ctx.strokeStyle = P3(ctx, rgbM[0], rgbM[1], rgbM[2], 0.085*intensity);
        ctx.beginPath();
        ctx.moveTo(px[0], px[1]);
        for(p=2;p<=lastIdx;p+=2){ ctx.lineTo(px[p], px[p+1]); }
        ctx.stroke();

        // --- bright thin core with along-length spectral shimmer ---
        // Draw in a few multi-segment sub-strokes (not one-per-segment) for perf,
        // each a small hue step => smooth rainbow shimmer down the curtain.
        var coreW = Math.max(oneDevPx*1.5, c.width * (0.6+intensity*0.45));
        ctx.lineWidth = coreW;
        var shimT = Math.sin(t*0.2 + i)*0.015;   // gentle temporal shimmer per curtain
        var sub = 4;                              // sub-strokes along length
        var perSub = seg/sub;
        for(var b=0;b<sub;b++){
          var sStart = Math.floor(b*perSub);
          var sEnd   = Math.floor((b+1)*perSub);
          if(b===sub-1) sEnd = seg;
          if(sEnd<=sStart) continue;

          // hue + vertical fade for this sub-stroke's midpoint
          var ymid = (sStart+sEnd)*0.5*invSeg;        // 0..1
          var hh = baseHue + ymid*0.10 + shimT;
          // soft top/bottom fade envelope so curtains read as floating veils,
          // and so the brightest core never paints a hard full-height bar.
          var fade = Math.sin(ymid*Math.PI);          // 0 at edges, 1 mid
          var coreA = 0.42*intensity*(0.35+0.65*fade);
          var rgbC = hsl2rgb(hh, 1.0, c.lum);
          ctx.strokeStyle = P3(ctx, rgbC[0], rgbC[1], rgbC[2], coreA);
          ctx.beginPath();
          var si = sStart*2;
          ctx.moveTo(px[si], px[si+1]);
          for(var q=sStart+1;q<=sEnd;q++){
            var qi = q*2;
            ctx.lineTo(px[qi], px[qi+1]);
          }
          ctx.stroke();
        }
      }

      // Clean up ctx state (leave it pristine for the next scene).
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
    }
  });
})();