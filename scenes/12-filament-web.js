(function(){
  "use strict";

  // ---- PRNG (mulberry32) ----
  function makePRNG(seed){
    var s = seed >>> 0;
    return function(){
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- Value noise (smooth, cheap) on a hashed lattice, 2D ----
  function makeNoise(prng){
    var P = new Uint8Array(512);
    var i, j, tmp;
    for(i=0;i<256;i++) P[i]=i;
    for(i=255;i>0;i--){
      j = (prng()*(i+1))|0;
      tmp = P[i]; P[i]=P[j]; P[j]=tmp;
    }
    for(i=0;i<256;i++) P[256+i]=P[i];

    function fade(t){ return t*t*t*(t*(t*6-15)+10); }
    function lerp(a,b,t){ return a+(b-a)*t; }
    function grad(h, x, y){
      switch(h & 3){
        case 0: return  x + y;
        case 1: return -x + y;
        case 2: return  x - y;
        default:return -x - y;
      }
    }
    return function(x,y){
      var X = Math.floor(x) & 255;
      var Y = Math.floor(y) & 255;
      var xf = x - Math.floor(x);
      var yf = y - Math.floor(y);
      var u = fade(xf), v = fade(yf);
      var aa = P[P[X]+Y];
      var ab = P[P[X]+Y+1];
      var ba = P[P[X+1]+Y];
      var bb = P[P[X+1]+Y+1];
      var x1 = lerp(grad(aa, xf, yf),     grad(ba, xf-1, yf),     u);
      var x2 = lerp(grad(ab, xf, yf-1),   grad(bb, xf-1, yf-1),   u);
      return lerp(x1, x2, v); // ~ -2..2
    };
  }

  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }

  // HSL->RGB (h 0..1, s 0..1, l 0..1) -> "r,g,b"
  function hslStr(h, s, l){
    var r,g,b;
    if(s===0){ r=g=b=l; }
    else{
      var hue2rgb = function(p,q,t){
        if(t<0)t+=1; if(t>1)t-=1;
        if(t<1/6) return p+(q-p)*6*t;
        if(t<1/2) return q;
        if(t<2/3) return p+(q-p)*(2/3-t)*6;
        return p;
      };
      var q = l<0.5 ? l*(1+s) : l+s-l*s;
      var p = 2*l-q;
      r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
    }
    return ((r*255)|0)+","+((g*255)|0)+","+((b*255)|0);
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Filament Web",
    setup: function(ctx, w, h){
      var state = {};
      if(w<=0||h<=0){ state.bad=true; return state; }

      var prng = makePRNG(0x9E3779B1 ^ ((w*131)|0) ^ ((h*977)|0));
      state.prng = prng;
      state.noise = makeNoise(prng);
      state.curl  = makeNoise(makePRNG(0x1234567 ^ ((w*31)|0)));

      // particle count scaled by area, clamped — many cheap hairlines.
      var area = w*h;
      var n = Math.round(area / 850);
      n = clamp(n, 1200, 4200);
      state.n = n;

      // SoA for particles
      state.px = new Float32Array(n);
      state.py = new Float32Array(n);
      state.life = new Float32Array(n);   // remaining life (seconds)
      state.maxlife = new Float32Array(n);
      state.hueoff = new Float32Array(n); // per-particle hue jitter

      for(var i=0;i<n;i++){
        state.px[i] = prng()*w;
        state.py[i] = prng()*h;
        var ml = 2.0 + prng()*5.0;
        state.maxlife[i] = ml;
        state.life[i] = prng()*ml;
        state.hueoff[i] = (prng()-0.5)*0.10;
      }

      // field params — spatial frequency of the flow field (in noise units)
      state.fieldScale = 0.0016;           // base spatial frequency
      state.curlScale  = 0.0011;
      state.speed = Math.min(w,h)*0.045;   // px/sec drift speed of filaments
      state.baseHue = prng();              // starting hue anchor
      state.dpr = (ctx.oledDPR && ctx.oledDPR>0) ? ctx.oledDPR : 1;
      // hairline ~1.1 device px; fall back to 0.6 CSS px if no oledDPR.
      state.hair = (ctx.oledDPR && ctx.oledDPR>0) ? (1.1 / state.dpr) : 0.6;
      state.seglen = Math.min(w,h)*0.012;  // short filament segment length (px)

      // slow global rotation clock
      state.rotPhase = prng()*Math.PI*2;

      // paint initial true-black background
      ctx.fillStyle = "#000";
      ctx.fillRect(0,0,w,h);

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if(state.bad || w<=0 || h<=0) return;
      if(dt>0.05) dt = 0.05; // clamp spikes
      if(dt<=0) dt = 0.016;

      var noise = state.noise;
      var curl  = state.curl;
      var n = state.n;
      var px = state.px, py = state.py;
      var life = state.life, maxlife = state.maxlife, hueoff = state.hueoff;
      var speed = state.speed;
      var fs = state.fieldScale, cs = state.curlScale;
      var prng = state.prng;
      var dpr = state.dpr;
      var seglen = state.seglen;

      // 1) gentle low-alpha black trail (filaments persist briefly then fade)
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.085)";
      ctx.fillRect(0,0,w,h);

      // 2) slowly evolving field offsets (morph) + slow global rotation
      var morphX = Math.sin(t*0.013)*900 + t*7.0;
      var morphY = Math.cos(t*0.011)*900 - t*5.0;
      var globalRot = state.rotPhase + Math.sin(t*0.018)*0.55 + t*0.012;
      var grx = Math.cos(globalRot), gry = Math.sin(globalRot);

      // hue rotates very slowly over time for long-session variety
      var baseHue = state.baseHue + t*0.006;

      // additive luminous threads
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = state.hair;
      ctx.lineCap = "round";

      var i, x, y, a1, a2, ang, vx, vy, hue, lum, alpha;

      for(i=0;i<n;i++){
        x = px[i]; y = py[i];

        // sample two octaves of noise to derive a flow angle
        a1 = noise(x*fs + morphX*0.001, y*fs + morphY*0.001);
        a2 = curl(x*cs - morphY*0.0008, y*cs + morphX*0.0008);
        ang = (a1*1.35 + a2*0.85) * Math.PI; // field direction

        // direction vector, then rotate by slow global rotation
        var dx = Math.cos(ang), dy = Math.sin(ang);
        vx = dx*grx - dy*gry;
        vy = dx*gry + dy*grx;

        // segment endpoints (the hairline filament)
        var ex = x + vx*seglen;
        var ey = y + vy*seglen;

        // hue mapped to flow direction (angle of the rotated vector)
        var dirAngle = Math.atan2(vy, vx); // -pi..pi
        hue = baseHue + dirAngle*0.0795775 + hueoff[i]; // /(2pi)
        hue = hue - Math.floor(hue);

        // life-based fade-in/out for shimmer (no flicker — smooth ramp)
        var lf = life[i] / maxlife[i]; // 1 -> 0
        var env = lf < 0.5 ? (lf*2) : (2 - lf*2); // triangular envelope
        env = env*env*(3-2*env); // smoothstep-ish
        // brightness also lifts where the two noise fields align
        var coh = clamp(Math.abs(a1+a2)*0.5, 0, 1);
        lum = 0.18 + 0.34*env + 0.10*coh;
        if(lum>0.62) lum = 0.62;
        alpha = 0.30 + 0.45*env;

        var sat = 0.78 + 0.18*coh;
        ctx.strokeStyle = "rgba("+hslStr(hue, sat, lum)+","+alpha.toFixed(3)+")";

        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        // pin-sharp bright tip on the strongest threads (crisp pinpoint)
        if(coh>0.72 && env>0.55){
          var ts = 1.3 / dpr;
          ctx.fillStyle = "rgba("+hslStr(hue, sat*0.6, Math.min(0.85,lum+0.25))+",0.9)";
          ctx.fillRect(ex - ts*0.5, ey - ts*0.5, ts, ts);
        }

        // advance particle along the field
        px[i] = x + vx*speed*dt;
        py[i] = y + vy*speed*dt;

        // age it
        life[i] -= dt;

        // respawn when dead or off-screen
        if(life[i] <= 0 || px[i] < -10 || px[i] > w+10 || py[i] < -10 || py[i] > h+10){
          px[i] = prng()*w;
          py[i] = prng()*h;
          var ml = 2.0 + prng()*5.0;
          maxlife[i] = ml;
          life[i] = ml;
          hueoff[i] = (prng()-0.5)*0.10;
        }
      }

      // restore clean context for the next scene
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
    }
  });
})();