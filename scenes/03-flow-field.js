(function(){
  "use strict";

  // ---- tiny deterministic value/perlin-ish noise (smooth, cheap, seedable) ----
  function makeNoise(seed){
    var p = new Uint8Array(512);
    var perm = new Uint8Array(256);
    var i;
    for(i=0;i<256;i++) perm[i]=i;
    // seeded shuffle (xorshift)
    var s = (seed>>>0) || 1;
    function rnd(){ s ^= s<<13; s>>>=0; s ^= s>>17; s ^= s<<5; s>>>=0; return s/4294967296; }
    for(i=255;i>0;i--){
      var j = (rnd()*(i+1))|0;
      var tmp = perm[i]; perm[i]=perm[j]; perm[j]=tmp;
    }
    for(i=0;i<512;i++) p[i]=perm[i&255];

    function fade(tt){ return tt*tt*tt*(tt*(tt*6-15)+10); }
    function lerp(a,b,tt){ return a+(b-a)*tt; }
    function grad(hh,x,y){
      // 8 directions
      switch(hh&7){
        case 0: return  x+y;
        case 1: return  x-y;
        case 2: return -x+y;
        case 3: return -x-y;
        case 4: return  x;
        case 5: return -x;
        case 6: return  y;
        default:return -y;
      }
    }
    // 2D perlin-ish, returns ~[-1,1]
    return function(x,y){
      var X = Math.floor(x)&255, Y = Math.floor(y)&255;
      x -= Math.floor(x); y -= Math.floor(y);
      var u = fade(x), v = fade(y);
      // p has 512 entries; max index used = p[X+1]+Y+1 <= 255+255+1 = 511 (safe)
      var aa = p[p[X]+Y], ab = p[p[X]+Y+1];
      var ba = p[p[X+1]+Y], bb = p[p[X+1]+Y+1];
      var r = lerp(
        lerp(grad(aa,x,y),   grad(ba,x-1,y),   u),
        lerp(grad(ab,x,y-1), grad(bb,x-1,y-1), u),
        v
      );
      return r; // roughly -1..1
    };
  }

  function hueToRGB(h){
    // h in [0,1) -> [r,g,b] 0..255, full sat
    h = h - Math.floor(h);
    var i = (h*6)|0;
    var f = h*6 - i;
    var q = 1 - f;
    switch(i%6){
      case 0: return [255, (f*255)|0, 0];
      case 1: return [(q*255)|0, 255, 0];
      case 2: return [0, 255, (f*255)|0];
      case 3: return [0, (q*255)|0, 255];
      case 4: return [(f*255)|0, 0, 255];
      default:return [255, 0, (q*255)|0];
    }
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Perlin Flow Field",

    setup: function(ctx, w, h){
      var state = {};
      state.w = w; state.h = h;

      // particle count scaled by area, clamped
      var n = Math.floor(w*h*0.0005);
      if(n < 300) n = 300;
      if(n > 1000) n = 1000;
      state.n = n;

      state.px = new Float32Array(n);
      state.py = new Float32Array(n);
      state.life = new Float32Array(n);
      state.maxlife = new Float32Array(n);
      state.spd = new Float32Array(n);

      // deterministic seeds so the field is stable per session but varied
      var seed = 1337;
      state.noise = makeNoise(seed);
      state.warp  = makeNoise(seed*7+11); // secondary field for domain warp

      // simple seeded rng for respawns (persisted so no flicker)
      var rs = 99173;
      state.rand = function(){
        rs ^= rs<<13; rs>>>=0; rs ^= rs>>17; rs ^= rs<<5; rs>>>=0;
        return rs/4294967296;
      };

      // spatial scale of the field (smaller => larger smooth swirls)
      var mx = Math.max(w,h,1);
      state.scale = 0.0016 * Math.min(1, 1200/mx) + 0.0009;

      var R = state.rand;
      for(var i=0;i<n;i++){
        state.px[i] = R()*w;
        state.py[i] = R()*h;
        state.maxlife[i] = 4 + R()*7;
        state.life[i] = R()*state.maxlife[i];
        state.spd[i] = 0.6 + R()*0.8;
      }

      // clear once to true black on (re)setup
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0,0,w,h);

      state.hueBase = 0;
      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if(w<=0 || h<=0) return;
      // sanitize dt (guard NaN / negative / spikes for stable motion)
      if(!(dt > 0)) dt = 0.016;
      if(dt > 0.1) dt = 0.1;

      // defensive: clear any leaked state from a previous scene
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";

      // gentle fading trails (keeps average luminance low, nothing static)
      ctx.fillStyle = "rgba(0,0,0,0.055)";
      ctx.fillRect(0,0,w,h);

      var noise = state.noise;
      var warp  = state.warp;
      var sc = state.scale;
      var R = state.rand;
      var n = state.n;

      // slow temporal evolution of the field
      var tz = t*0.06;
      var warpAmt = 120; // pixels of domain warp
      state.hueBase = (t*0.012) % 1;

      ctx.globalCompositeOperation = "lighter";

      var TWO_PI = Math.PI*2;

      for(var i=0;i<n;i++){
        var x = state.px[i];
        var y = state.py[i];

        // domain warp for organic curl-like motion
        var wx = warp(x*sc*0.6 + tz, y*sc*0.6 - tz);
        var wy = warp(x*sc*0.6 + 31.7 - tz, y*sc*0.6 + 5.3 + tz);

        var nx = (x + wx*warpAmt)*sc;
        var ny = (y + wy*warpAmt)*sc;

        // field angle from noise; multiply for richer turning
        var ang = noise(nx + tz*0.5, ny - tz*0.5) * Math.PI * 2.2;

        var sp = state.spd[i] * 42; // base px/sec
        var vx = Math.cos(ang)*sp;
        var vy = Math.sin(ang)*sp;

        x += vx*dt;
        y += vy*dt;

        // life
        state.life[i] += dt;

        // respawn: off-screen or life exceeded
        var dead = state.life[i] > state.maxlife[i] ||
                   x < -20 || x > w+20 || y < -20 || y > h+20;
        if(dead){
          x = R()*w;
          y = R()*h;
          state.life[i] = 0;
          state.maxlife[i] = 4 + R()*7;
          state.spd[i] = 0.6 + R()*0.8;
        }

        state.px[i] = x;
        state.py[i] = y;

        // fade in/out over lifetime (no popping)
        var lf = state.life[i] / state.maxlife[i];
        var fade = Math.sin(lf*Math.PI); // 0->1->0
        if(fade < 0) fade = 0;

        // hue mapped to flow direction + position drift
        var hue = state.hueBase + (ang/TWO_PI)*0.18 + (y/h)*0.25 + (x/w)*0.08;
        var rgb = hueToRGB(hue);

        var alpha = 0.5 * fade;
        if(alpha <= 0.002) continue;

        // luminous soft dot via small radial gradient
        var rad = (2.2 + fade*2.0) * 2.4;
        var g = ctx.createRadialGradient(x,y,0, x,y,rad);
        g.addColorStop(0, "rgba("+rgb[0]+","+rgb[1]+","+rgb[2]+","+alpha+")");
        g.addColorStop(0.5, "rgba("+rgb[0]+","+rgb[1]+","+rgb[2]+","+(alpha*0.35)+")");
        g.addColorStop(1, "rgba("+rgb[0]+","+rgb[1]+","+rgb[2]+",0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x,y,rad,0,TWO_PI);
        ctx.fill();
      }

      // reset leaked state for the next scene
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  });
})();