(function(){ "use strict";

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

  // Small deterministic PRNG (mulberry32)
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
    name:"Spectrum Plasma",

    setup:function(ctx,w,h){
      var rand = mulberry32(0x5C0FFEE7);
      var n = 7; // number of large soft blobs (capped, cheap)
      var blobs = [];
      var diag = Math.sqrt(w*w+h*h) || 1000;
      for(var i=0;i<n;i++){
        blobs.push({
          // each blob orbits on its own slow Lissajous-ish path
          ax: 0.18 + rand()*0.30,            // amplitude (fraction of w) x
          ay: 0.18 + rand()*0.30,            // amplitude (fraction of h) y
          fx: 0.010 + rand()*0.030,          // freq x (rad/sec)
          fy: 0.010 + rand()*0.030,          // freq y
          px: rand()*Math.PI*2,              // phase x
          py: rand()*Math.PI*2,              // phase y
          cx: 0.30 + rand()*0.40,            // center bias x (frac)
          cy: 0.30 + rand()*0.40,            // center bias y
          radFrac: 0.15 + rand()*0.15,       // soft radius (smaller -> distinct clouds on visible black)
          hueOff: rand(),                    // hue offset for spatial variation
          hueRate: 0.018 + rand()*0.020,     // per-blob hue drift
          breathF: 0.02 + rand()*0.04,       // radius breathing freq
          breathP: rand()*Math.PI*2,
          breathA: 0.10 + rand()*0.12        // radius breathing amount
        });
      }
      // setup re-runs on every resize, so diag (and thus radii) always track the live size.
      return { rand:rand, blobs:blobs, diag:diag };
    },

    draw:function(ctx,w,h,t,dt,state){
      if(w<=0||h<=0) return;
      if(!(dt>0)) dt=0.016;
      if(dt>0.05) dt=0.05; // clamp big frame gaps (tab refocus, GC pauses)

      // True-black background each frame (no trails for clean plasma).
      ctx.globalCompositeOperation="source-over";
      ctx.globalAlpha=1;
      ctx.lineWidth=1;
      ctx.fillStyle="#000000";
      ctx.fillRect(0,0,w,h);

      var blobs = state && state.blobs;
      if(!blobs || !blobs.length) return;

      var diag = state.diag || (Math.sqrt(w*w+h*h) || 1000);

      // Global slow hue sweep through the FULL wheel (continuous, never static).
      var baseHue = t*0.035;

      ctx.save();
      ctx.globalCompositeOperation="lighter"; // additive merging = gooey plasma

      for(var i=0;i<blobs.length;i++){
        var b=blobs[i];

        // Slow organic drift across the field (nothing pins static).
        var fx = b.cx + b.ax*Math.sin(t*b.fx + b.px) * Math.cos(t*b.fx*0.6 + b.py*0.5);
        var fy = b.cy + b.ay*Math.sin(t*b.fy + b.py) * Math.cos(t*b.fy*0.7 + b.px*0.5);
        var x = fx*w;
        var y = fy*h;

        // Breathing radius so nothing pins static (size-relative -> resize-safe).
        var rad = b.radFrac * diag * (1 + b.breathA*Math.sin(t*b.breathF + b.breathP));
        if(rad < 1) rad = 1;

        // Hue cycles continuously: global sweep + per-blob drift + spatial term.
        var hue = baseHue + b.hueOff + t*b.hueRate + (fx*0.22 + fy*0.18);
        var rgb = hsl2rgb(hue, 1.0, 0.52); // fully saturated, mid lightness (not white)

        // Soft radial gradient, saturated core fading to fully transparent.
        // Moderate peak alpha so additive overlaps stay COLORED, not blown to white.
        var g = ctx.createRadialGradient(x,y,0, x,y,rad);
        g.addColorStop(0.00, P3(ctx, rgb[0], rgb[1], rgb[2], 0.34));
        g.addColorStop(0.25, P3(ctx, rgb[0], rgb[1], rgb[2], 0.11));
        g.addColorStop(0.50, P3(ctx, rgb[0], rgb[1], rgb[2], 0.02));
        g.addColorStop(0.75, P3(ctx, rgb[0], rgb[1], rgb[2], 0.0));
        g.addColorStop(1.00, P3(ctx, rgb[0], rgb[1], rgb[2], 0.0));

        ctx.fillStyle=g;
        ctx.beginPath();
        ctx.arc(x,y,rad,0,Math.PI*2);
        ctx.fill();
      }

      ctx.restore();

      // Leave ctx clean for the next scene/frame.
      ctx.globalCompositeOperation="source-over";
      ctx.globalAlpha=1;
      ctx.lineWidth=1;
    }
  });

})();