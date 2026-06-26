(function(){
  "use strict";

  // ---- tiny PRNG (mulberry32) ----
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- value noise for flow field (smooth, seeded) ----
  function makeNoise(rng){
    var P = new Uint8Array(512);
    var i, j, tmp;
    for(i=0;i<256;i++) P[i]=i;
    for(i=255;i>0;i--){ j=(rng()*(i+1))|0; tmp=P[i]; P[i]=P[j]; P[j]=tmp; }
    for(i=0;i<256;i++) P[256+i]=P[i];
    function fade(t){ return t*t*t*(t*(t*6-15)+10); }
    function lerp(a,b,t){ return a+(b-a)*t; }
    function grad(hh,x,y){
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
    return function(x,y){
      var X = Math.floor(x)&255, Y = Math.floor(y)&255;
      var xf = x-Math.floor(x), yf = y-Math.floor(y);
      var u = fade(xf), v = fade(yf);
      var aa = P[P[X]+Y], ab = P[P[X]+Y+1];
      var ba = P[P[X+1]+Y], bb = P[P[X+1]+Y+1];
      var x1 = lerp(grad(aa,xf,yf),     grad(ba,xf-1,yf),     u);
      var x2 = lerp(grad(ab,xf,yf-1),   grad(bb,xf-1,yf-1),   u);
      return lerp(x1,x2,v); // ~[-1,1]
    };
  }

  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }

  // Bioluminescent palette: teal / cyan / violet ; returns [r,g,b]
  function paletteColor(rng){
    var r = rng();
    if(r < 0.40){        // teal-cyan
      return [ 40+rng()*40, 200+rng()*55, 210+rng()*45 ];
    } else if(r < 0.74){ // pure cyan / aqua
      return [ 60+rng()*60, 170+rng()*60, 245+rng()*10 ];
    } else if(r < 0.92){ // violet
      return [ 150+rng()*60, 90+rng()*50, 245+rng()*10 ];
    } else {             // rare greenish-white sparkle
      return [ 200+rng()*55, 245+rng()*10, 235+rng()*20 ];
    }
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Plankton Net",

    setup: function(ctx, w, h){
      var state = {};
      if(w<=0 || h<=0){ state.bad = true; return state; }

      // hairline + pinpoint sizing in CSS px from device-pixel scale
      var hasDPR = !!(ctx && ctx.oledDPR);
      var dpr = hasDPR ? ctx.oledDPR : 1.5;
      state.dpr = dpr;
      // true ~1 device-px hairline; fall back to 0.6 CSS px if dpr unknown
      state.hair = hasDPR ? (1 / dpr) : 0.6;
      // pinpoint core radius ~0.75 device px (=> ~1.5 device px diameter)
      state.ptR = hasDPR ? (0.75 / dpr) : 0.5;
      // floor so smallest motes never go sub-pixel invisible (~0.6 device px)
      state.ptMin = hasDPR ? (0.6 / dpr) : 0.4;

      var rng = mulberry32(0x51A2C7 ^ ((w*131+h*977)|0));
      state.rng = rng;
      state.noise = makeNoise(rng);

      // count scaled by area, clamped
      var area = w*h;
      var N = Math.round(area / 4200);
      N = clamp(N, 220, 560);
      state.N = N;

      // spatial grid for proximity (cell ~ linkDist)
      var link = Math.min(w,h) * 0.072;     // connection radius
      state.link = link;
      state.link2 = link*link;
      var cs = link;                         // cell size = link dist
      state.cs = cs;
      state.gw = Math.max(1, Math.ceil(w/cs)+2);
      state.gh = Math.max(1, Math.ceil(h/cs)+2);
      state.gridHead = new Int32Array(state.gw*state.gh);
      state.gridNext = new Int32Array(N);

      // particle arrays
      var px = new Float32Array(N), py = new Float32Array(N);
      var vx = new Float32Array(N), vy = new Float32Array(N);
      var pr = new Float32Array(N);          // size factor
      var br = new Float32Array(N);          // base brightness
      var phase = new Float32Array(N);       // pulse phase
      var pspd = new Float32Array(N);        // pulse speed
      var cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
      var glow = new Uint8Array(N);          // is a bright "glow" mote

      for(var i=0;i<N;i++){
        px[i] = rng()*w;
        py[i] = rng()*h;
        vx[i] = 0; vy[i] = 0;
        pr[i] = 0.7 + rng()*1.0;
        br[i] = 0.35 + rng()*0.55;
        phase[i] = rng()*Math.PI*2;
        pspd[i] = 0.25 + rng()*0.6;
        var c = paletteColor(rng);
        cr[i]=c[0]; cg[i]=c[1]; cb[i]=c[2];
        glow[i] = (rng() < 0.10) ? 1 : 0;   // ~10% get soft halo
      }

      state.px=px; state.py=py; state.vx=vx; state.vy=vy;
      state.pr=pr; state.br=br; state.phase=phase; state.pspd=pspd;
      state.cr=cr; state.cg=cg; state.cb=cb; state.glow=glow;

      // screen-position scratch buffers (no per-frame alloc)
      state.SX = new Float32Array(N);
      state.SY = new Float32Array(N);

      // forward neighbor cell offsets for once-per-pair filament scan
      state.OFF = [0,0, 1,0, -1,1, 0,1, 1,1];

      // global slow drift + rotation so nothing pins
      state.cx = w*0.5; state.cy = h*0.5;
      state.flowScale = 1/Math.max(220, Math.min(w,h)*0.45);
      state.t0phase = rng()*1000;

      return state;
    },

    draw: function(ctx, w, h, t, dt, state){
      if(!state || state.bad || w<=0 || h<=0){
        if(ctx){ ctx.fillStyle="#000"; ctx.fillRect(0,0,Math.max(0,w),Math.max(0,h)); }
        return;
      }
      dt = clamp(dt, 0.001, 0.05);

      var N = state.N;
      var px=state.px, py=state.py, vx=state.vx, vy=state.vy;
      var pr=state.pr, br=state.br, phase=state.phase, pspd=state.pspd;
      var cr=state.cr, cg=state.cg, cb=state.cb, glow=state.glow;
      var noise = state.noise;
      var rng = state.rng;

      // ---- background: gentle motion-trail black (mostly true black) ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.fillRect(0,0,w,h);

      // ---- whole-field slow drift & rotation (keep anchors moving) ----
      var driftAng = t*0.013 + state.t0phase;
      var driftX = Math.cos(driftAng*0.7) * (w*0.045);
      var driftY = Math.sin(driftAng*0.9) * (h*0.045);
      var rot = Math.sin(t*0.011) * 0.10;     // small slow rotation
      var cosR = Math.cos(rot), sinR = Math.sin(rot);
      var cx = state.cx, cy = state.cy;

      var fs = state.flowScale;
      var tnoiseA = t*0.05;
      var tnoiseB = t*0.05 + 31.7;

      // ---- update motes: flow field + brownian jitter ----
      var flowSpeed = Math.min(w,h) * 0.012;   // base current speed (CSS px/s)
      var jit = Math.min(w,h) * 0.0009;
      var TWO_PI = Math.PI*2;
      for(var i=0;i<N;i++){
        var x=px[i], y=py[i];
        // curl-ish flow from two noise samples
        var a = noise(x*fs + tnoiseA, y*fs - tnoiseA) * TWO_PI;
        var s = 0.55 + 0.45*noise(x*fs*0.5 - tnoiseB, y*fs*0.5 + tnoiseB);
        var fxv = Math.cos(a) * flowSpeed * s;
        var fyv = Math.sin(a) * flowSpeed * s;

        // brownian jitter (seeded PRNG; folds into persisted velocity, no flicker)
        var jx = (rng()-0.5) * jit;
        var jy = (rng()-0.5) * jit;

        // integrate velocity (smooth approach to flow + jitter)
        vx[i] += (fxv - vx[i]) * 1.6 * dt + jx;
        vy[i] += (fyv - vy[i]) * 1.6 * dt + jy;

        x += vx[i] * dt;
        y += vy[i] * dt;

        // wrap with margin so web stays continuous
        var m = 12;
        if(x < -m) x += w + 2*m; else if(x > w+m) x -= w + 2*m;
        if(y < -m) y += h + 2*m; else if(y > h+m) y -= h + 2*m;

        px[i]=x; py[i]=y;
      }

      // ---- precompute screen positions (drift + rigid rotation about center) ----
      var SX = state.SX, SY = state.SY;
      for(var k=0;k<N;k++){
        var dxk = px[k]-cx, dyk = py[k]-cy;
        SX[k] = cx + (dxk*cosR - dyk*sinR) + driftX;
        SY[k] = cy + (dxk*sinR + dyk*cosR) + driftY;
      }

      // ---- build spatial grid (on raw px/py; transform is rigid, distances preserved) ----
      var cs=state.cs, gw=state.gw, gh=state.gh;
      var head=state.gridHead, nxt=state.gridNext;
      head.fill(-1);
      for(var p=0;p<N;p++){
        var gx = (px[p]/cs + 1)|0; if(gx<0)gx=0; else if(gx>=gw)gx=gw-1;
        var gy = (py[p]/cs + 1)|0; if(gy<0)gy=0; else if(gy>=gh)gy=gh-1;
        var ci = gy*gw + gx;
        nxt[p] = head[ci];
        head[ci] = p;
      }

      // ---- draw filaments (hair-thin proximity web), additive ----
      // Each unordered pair drawn once: scan this cell + 4 "forward" neighbor
      // cells; within the same cell only link b>a.
      var link2 = state.link2;
      var invLink = 1/Math.sqrt(link2);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = state.hair;
      ctx.lineCap = "round";

      var OFF = state.OFF;
      var nOff = OFF.length;

      for(var gyi=1; gyi<gh-1; gyi++){
        for(var gxi=1; gxi<gw-1; gxi++){
          var a0 = head[gyi*gw+gxi];
          while(a0 !== -1){
            var ax=px[a0], ay=py[a0];
            for(var o=0;o<nOff;o+=2){
              var ox=OFF[o], oy=OFF[o+1];
              var sameCell = (ox===0 && oy===0);
              var nb = head[(gyi+oy)*gw + (gxi+ox)];
              while(nb !== -1){
                // same cell: only b>a so each pair counted once
                if(!sameCell || nb > a0){
                  var ddx = px[nb]-ax, ddy = py[nb]-ay;
                  var d2 = ddx*ddx + ddy*ddy;
                  if(d2 < link2){
                    var d = Math.sqrt(d2);
                    var prox = 1 - d*invLink;        // 0..1
                    if(prox > 0.02){
                      var alpha = prox*prox*0.42;
                      var rr = (cr[a0]+cr[nb])*0.5;
                      var gg = (cg[a0]+cg[nb])*0.5;
                      var bb = (cb[a0]+cb[nb])*0.5;
                      ctx.strokeStyle = "rgba("+(rr|0)+","+(gg|0)+","+(bb|0)+","+alpha.toFixed(3)+")";
                      ctx.beginPath();
                      ctx.moveTo(SX[a0], SY[a0]);
                      ctx.lineTo(SX[nb], SY[nb]);
                      ctx.stroke();
                    }
                  }
                }
                nb = nxt[nb];
              }
            }
            a0 = nxt[a0];
          }
        }
      }

      // ---- soft glow for the bright few (additive radial) ----
      var ptR = state.ptR;
      for(var gi=0; gi<N; gi++){
        if(!glow[gi]) continue;
        var pulse = 0.55 + 0.45*Math.sin(phase[gi] + t*pspd[gi]);
        var ga = 0.16 * br[gi] * pulse;
        if(ga < 0.01) continue;
        var X = SX[gi], Y = SY[gi];
        var grRad = (ptR*8) * (0.8 + pulse*0.6);
        if(grRad < 1) grRad = 1;
        var rgrad = ctx.createRadialGradient(X,Y,0, X,Y,grRad);
        rgrad.addColorStop(0, "rgba("+(cr[gi]|0)+","+(cg[gi]|0)+","+(cb[gi]|0)+","+ga.toFixed(3)+")");
        rgrad.addColorStop(1, "rgba("+(cr[gi]|0)+","+(cg[gi]|0)+","+(cb[gi]|0)+",0)");
        ctx.fillStyle = rgrad;
        ctx.beginPath();
        ctx.arc(X,Y,grRad,0,Math.PI*2);
        ctx.fill();
      }

      // ---- crisp pinpoint cores for ALL motes (tiny arcs, additive) ----
      var ptMin = state.ptMin;
      for(var c2=0; c2<N; c2++){
        var pl = 0.6 + 0.4*Math.sin(phase[c2] + t*pspd[c2]);
        var ca = clamp(br[c2]*pl*0.95, 0, 1);
        var X2 = SX[c2], Y2 = SY[c2];
        var rad = ptR * pr[c2];
        if(rad < ptMin) rad = ptMin;
        ctx.fillStyle = "rgba("+(cr[c2]|0)+","+(cg[c2]|0)+","+(cb[c2]|0)+","+ca.toFixed(3)+")";
        ctx.beginPath();
        ctx.arc(X2, Y2, rad, 0, Math.PI*2);
        ctx.fill();
      }

      // ---- restore clean context ----
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
    }
  });
})();
