(function(){
  "use strict";

  // ---- tiny seeded PRNG (mulberry32) ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- value-noise (smooth, looping-friendly) for nebula morphing ----
  function makeNoise(rng){
    var SZ = 256, MASK = 255;
    var p = new Uint8Array(SZ);
    for (var i=0;i<SZ;i++) p[i]=i;
    for (var j=SZ-1;j>0;j--){
      var k=(rng()*(j+1))|0; var tmp=p[j]; p[j]=p[k]; p[k]=tmp;
    }
    var grad = new Float32Array(SZ);
    for (var g=0; g<SZ; g++) grad[g] = rng()*2-1;
    function fade(t){ return t*t*t*(t*(t*6-15)+10); }
    function lerp(a,b,t){ return a+(b-a)*t; }
    // 2D value noise. IMPORTANT: every intermediate p[] lookup must be masked
    // to 0..255, otherwise indices can exceed the Uint8Array length and
    // return undefined -> NaN, which would corrupt all nebula positions.
    return function(x,y){
      var xi=Math.floor(x)&MASK, yi=Math.floor(y)&MASK;
      var xi1=(xi+1)&MASK, yi1=(yi+1)&MASK;
      var xf=x-Math.floor(x), yf=y-Math.floor(y);
      var u=fade(xf), v=fade(yf);
      var aa=grad[p[(p[xi]+yi)&MASK]];
      var ab=grad[p[(p[xi]+yi1)&MASK]];
      var ba=grad[p[(p[xi1]+yi)&MASK]];
      var bb=grad[p[(p[xi1]+yi1)&MASK]];
      var x1=lerp(aa,ba,u), x2=lerp(ab,bb,u);
      return lerp(x1,x2,v); // ~[-1,1]
    };
  }

  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Cosmic Nebula Drift",

    setup: function(ctx, w, h){
      if (w<=0 || h<=0) return {};
      var rng = mulberry32(0x5eed1234);
      var noise = makeNoise(mulberry32(0x9a17c0de));
      var area = w*h;

      // ---- star layers (3 depths) ----
      // counts scaled by area but clamped for perf
      var baseStars = clamp(Math.floor(area*0.00018), 80, 900);
      var layerDefs = [
        { frac:0.50, speed:6,  rad:[0.4,0.9], bri:[0.18,0.40], tw:[0.10,0.35] }, // far
        { frac:0.33, speed:14, rad:[0.7,1.4], bri:[0.30,0.60], tw:[0.20,0.55] }, // mid
        { frac:0.17, speed:26, rad:[1.0,2.1], bri:[0.45,0.85], tw:[0.35,0.80] }  // near
      ];
      var layers = [];
      for (var L=0; L<layerDefs.length; L++){
        var d = layerDefs[L];
        var n = Math.max(8, Math.floor(baseStars*d.frac));
        var arr = new Array(n);
        for (var i=0;i<n;i++){
          var rr = d.rad[0] + rng()*(d.rad[1]-d.rad[0]);
          var br = d.bri[0] + rng()*(d.bri[1]-d.bri[0]);
          var tw = d.tw[0] + rng()*(d.tw[1]-d.tw[0]);
          // subtle star color: mostly white-blue, a few warm
          var warm = rng();
          var col;
          if (warm > 0.86)      col = [255, 220, 180]; // warm
          else if (warm > 0.70) col = [200, 220, 255]; // cool blue
          else                  col = [235, 240, 255]; // white
          arr[i] = {
            x: rng()*w,
            y: rng()*h,
            r: rr,
            b: br,
            twAmp: tw,
            twSpd: 0.4 + rng()*1.3,
            twPh: rng()*Math.PI*2,
            col: col
          };
        }
        layers.push({ stars: arr, speed: d.speed, dir: -1 }); // drift left
      }

      // ---- nebula blobs (large soft additive gradients) ----
      var palette = [
        [70, 40, 160],   // deep indigo
        [150, 40, 150],  // magenta
        [40, 120, 140],  // teal
        [90, 30, 170],   // violet
        [40, 90, 160]    // blue
      ];
      var nBlobs = clamp(Math.floor(area*0.0000065), 5, 9);
      var blobs = new Array(nBlobs);
      var minDim = Math.min(w,h);
      for (var k=0;k<nBlobs;k++){
        var c = palette[(rng()*palette.length)|0];
        // slow continuous migration of each blob center so the large soft
        // glows never sit on the same pixels for long (OLED burn-in safety).
        var migAng = rng()*Math.PI*2;
        blobs[k] = {
          baseX: rng()*w,
          baseY: rng()*h,
          R: minDim*(0.32 + rng()*0.40),
          col: c,
          // each blob morphs through its own slow noise field offset
          nx: rng()*100,
          ny: rng()*100,
          driftSpd: 0.006 + rng()*0.012,
          driftAng: rng()*Math.PI*2,
          pulseSpd: 0.03 + rng()*0.05,
          pulsePh: rng()*Math.PI*2,
          wobble: minDim*(0.05 + rng()*0.10),
          alpha: 0.05 + rng()*0.05,
          // slow drift velocity (px/sec) for the anchor itself
          migVX: Math.cos(migAng)*(minDim*0.004 + rng()*minDim*0.006),
          migVY: Math.sin(migAng)*(minDim*0.004 + rng()*minDim*0.006)
        };
      }

      return {
        rng: rng,
        noise: noise,
        layers: layers,
        blobs: blobs,
        w: w, h: h,
        // shooting star scheduler
        shoot: null,
        nextShoot: 4 + rng()*8
      };
    },

    draw: function(ctx, w, h, t, dt, state){
      if (w<=0 || h<=0 || !state.layers) return;
      if (dt>0.1) dt = 0.1; // clamp spikes
      if (dt<0) dt = 0;

      // ---- background: true black painted every frame ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0,0,w,h);

      // ===== NEBULA (additive soft gradients morphing via value noise) =====
      ctx.globalCompositeOperation = "lighter";
      var noise = state.noise;
      var blobs = state.blobs;
      var marginX = w*0.25, marginY = h*0.25;
      for (var k=0;k<blobs.length;k++){
        var b = blobs[k];

        // slow continuous migration of the anchor; wrap with margins so the
        // glow drifts fully across the screen over minutes (no static center).
        b.baseX += b.migVX*dt;
        b.baseY += b.migVY*dt;
        if (b.baseX < -marginX) b.baseX = w+marginX;
        else if (b.baseX > w+marginX) b.baseX = -marginX;
        if (b.baseY < -marginY) b.baseY = h+marginY;
        else if (b.baseY > h+marginY) b.baseY = -marginY;

        // slow positional drift + noise wobble
        var nxv = noise(b.nx + t*b.driftSpd, b.ny);
        var nyv = noise(b.ny, b.nx + t*b.driftSpd*0.8);
        var cx = b.baseX + Math.cos(b.driftAng)*nxv*b.wobble*3
                         + Math.cos(t*b.driftSpd*1.3 + b.pulsePh)* b.wobble;
        var cy = b.baseY + Math.sin(b.driftAng)*nyv*b.wobble*3
                         + Math.sin(t*b.driftSpd*1.1 + b.pulsePh)* b.wobble;

        // low-frequency intensity pulse, never to zero, never harsh
        var pulse = 0.55 + 0.45*(0.5 + 0.5*Math.sin(t*b.pulseSpd*Math.PI*2 + b.pulsePh));
        // extra noise-driven density variation
        var dens = 0.6 + 0.4*(0.5 + 0.5*noise(b.nx*0.3 + t*0.01, b.ny*0.3));
        var a = b.alpha * pulse * dens;
        var R = b.R * (0.9 + 0.15*Math.sin(t*b.pulseSpd*0.7 + b.pulsePh));
        if (R <= 0 || a <= 0.0005) continue;

        var col = b.col;
        var grad = ctx.createRadialGradient(cx,cy,0, cx,cy,R);
        grad.addColorStop(0,   "rgba("+col[0]+","+col[1]+","+col[2]+","+(a).toFixed(4)+")");
        grad.addColorStop(0.45,"rgba("+col[0]+","+col[1]+","+col[2]+","+(a*0.45).toFixed(4)+")");
        grad.addColorStop(1,   "rgba("+col[0]+","+col[1]+","+col[2]+",0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx,cy,R,0,Math.PI*2);
        ctx.fill();
      }

      // ===== STARFIELD (3 parallax layers, twinkling) =====
      var layers = state.layers;
      for (var Li=0; Li<layers.length; Li++){
        var ly = layers[Li];
        var stars = ly.stars;
        var dxm = ly.dir * ly.speed * dt;
        for (var i=0;i<stars.length;i++){
          var s = stars[i];
          s.x += dxm;
          if (s.x < -4) { s.x = w+4; s.y = state.rng()*h; }
          else if (s.x > w+4) { s.x = -4; s.y = state.rng()*h; }

          // twinkle: smooth, never fully off (no flicker)
          var tw = 1 - s.twAmp + s.twAmp*(0.5+0.5*Math.sin(t*s.twSpd + s.twPh));
          var bri = s.b * tw;
          if (bri <= 0.01) continue;

          var c = s.col;
          // small soft glow for brighter stars only (perf)
          if (s.r > 1.0){
            var gr = ctx.createRadialGradient(s.x,s.y,0, s.x,s.y,s.r*4);
            gr.addColorStop(0, "rgba("+c[0]+","+c[1]+","+c[2]+","+(bri*0.55).toFixed(4)+")");
            gr.addColorStop(1, "rgba("+c[0]+","+c[1]+","+c[2]+",0)");
            ctx.fillStyle = gr;
            ctx.beginPath();
            ctx.arc(s.x,s.y,s.r*4,0,Math.PI*2);
            ctx.fill();
          }
          // crisp core
          ctx.fillStyle = "rgba("+c[0]+","+c[1]+","+c[2]+","+bri.toFixed(4)+")";
          ctx.beginPath();
          ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
          ctx.fill();
        }
      }

      // ===== SHOOTING STAR (occasional, slow streak) =====
      state.nextShoot -= dt;
      if (!state.shoot && state.nextShoot <= 0){
        var rng = state.rng;
        var sx = rng()*w*0.8 + w*0.1;
        var sy = rng()*h*0.4;
        var ang = (Math.PI*0.18) + rng()*Math.PI*0.18; // shallow downward
        if (rng()>0.5) ang = Math.PI - ang; // mirror direction
        var spd = (w*0.18) + rng()*w*0.10;  // px/sec, slow & graceful
        state.shoot = {
          x: sx, y: sy,
          vx: Math.cos(ang)*spd,
          vy: Math.sin(ang)*spd,
          life: 0,
          maxLife: 1.6 + rng()*1.0,
          len: 120 + rng()*120,
          hue: rng()>0.6 ? [200,220,255] : [255,235,210]
        };
        state.nextShoot = 9 + rng()*16;
      }

      if (state.shoot){
        var sh = state.shoot;
        sh.life += dt;
        sh.x += sh.vx*dt;
        sh.y += sh.vy*dt;
        // fade in then out
        var lf = sh.life / sh.maxLife;
        var env = Math.sin(clamp(lf,0,1)*Math.PI); // 0..1..0
        if (lf >= 1 || sh.x < -200 || sh.x > w+200 || sh.y > h+200){
          state.shoot = null;
        } else {
          var nlen = Math.sqrt(sh.vx*sh.vx + sh.vy*sh.vy) || 1;
          var ux = sh.vx/nlen, uy = sh.vy/nlen;
          var tailX = sh.x - ux*sh.len;
          var tailY = sh.y - uy*sh.len;
          var hc = sh.hue;
          var lg = ctx.createLinearGradient(sh.x, sh.y, tailX, tailY);
          var ha = (0.75*env).toFixed(4);
          lg.addColorStop(0, "rgba("+hc[0]+","+hc[1]+","+hc[2]+","+ha+")");
          lg.addColorStop(0.4,"rgba("+hc[0]+","+hc[1]+","+hc[2]+","+(0.25*env).toFixed(4)+")");
          lg.addColorStop(1, "rgba("+hc[0]+","+hc[1]+","+hc[2]+",0)");
          ctx.strokeStyle = lg;
          ctx.lineWidth = 2;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(sh.x, sh.y);
          ctx.stroke();
          // bright head glow
          var hg = ctx.createRadialGradient(sh.x,sh.y,0, sh.x,sh.y,6);
          hg.addColorStop(0,"rgba("+hc[0]+","+hc[1]+","+hc[2]+","+(0.9*env).toFixed(4)+")");
          hg.addColorStop(1,"rgba("+hc[0]+","+hc[1]+","+hc[2]+",0)");
          ctx.fillStyle = hg;
          ctx.beginPath();
          ctx.arc(sh.x,sh.y,6,0,Math.PI*2);
          ctx.fill();
        }
      }

      // ---- reset leaked canvas state for the next scene ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  });
})();