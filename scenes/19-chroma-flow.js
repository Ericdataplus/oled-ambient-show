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

  // small deterministic PRNG (mulberry32)
  function mulberry32(a){
    return function(){
      a|=0; a=(a+0x6D2B79F5)|0;
      var t=Math.imul(a^(a>>>15),1|a);
      t=(t+Math.imul(t^(t>>>7),61|t))^t;
      return ((t^(t>>>14))>>>0)/4294967296;
    };
  }

  // gradient (Perlin-style) 2D noise -> ~ -1..1
  function makeNoise(rng){
    var perm=new Uint8Array(256);
    var P=new Uint8Array(512);
    var i;
    for(i=0;i<256;i++)perm[i]=i;
    for(i=255;i>0;i--){ var j=(rng()*(i+1))|0; var tmp=perm[i];perm[i]=perm[j];perm[j]=tmp; }
    for(i=0;i<512;i++)P[i]=perm[i&255];
    var grad=new Float32Array(256*2); // 256 unit vectors
    for(i=0;i<256;i++){ var ang=rng()*6.2831853; grad[i*2]=Math.cos(ang); grad[i*2+1]=Math.sin(ang); }
    function fade(t){return t*t*t*(t*(t*6-15)+10);}
    function lerp(a,b,t){return a+(b-a)*t;}
    function gi(ix,iy){ return (P[(ix&255)+P[iy&255]]&255)*2; }
    return function(x,y){
      var X=Math.floor(x),Y=Math.floor(y);
      var xf=x-X,yf=y-Y;
      var u=fade(xf),v=fade(yf);
      var aa=gi(X,Y),ab=gi(X,Y+1),ba=gi(X+1,Y),bb=gi(X+1,Y+1);
      var d00=grad[aa]*xf      +grad[aa+1]*yf;
      var d10=grad[ba]*(xf-1)  +grad[ba+1]*yf;
      var d01=grad[ab]*xf      +grad[ab+1]*(yf-1);
      var d11=grad[bb]*(xf-1)  +grad[bb+1]*(yf-1);
      var x1=lerp(d00,d10,u), x2=lerp(d01,d11,u);
      return lerp(x1,x2,v); // ~ -1..1
    };
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name:"Chroma Flow",
    setup:function(ctx,w,h){
      if(w<=0||h<=0){ w=1; h=1; }
      var rng=mulberry32(0x9E3779B1);
      var noise=makeNoise(rng);
      // particle count scaled to area, capped for 60fps
      var N = Math.max(120, Math.min(700, Math.floor((w*h)/3200)));
      var ps=new Array(N);
      // spatial frequency of flow field (grid units per pixel)
      var scale = 0.0018;
      for(var i=0;i<N;i++){
        var px=rng()*w, py=rng()*h;
        ps[i]={
          x:px, y:py, px:px, py:py,
          life:rng()*4, maxlife:7+rng()*9,
          hueOff:rng(),
          spd:0.7+rng()*0.7,
          size:0.6+rng()*1.2
        };
      }
      return {rng:rng,noise:noise,ps:ps,N:N,scale:scale};
    },
    draw:function(ctx,w,h,t,dt,state){
      if(w<=0||h<=0)return;
      if(!(dt>0)||dt!==dt) dt=0.016;
      if(dt>0.05)dt=0.05;
      var noise=state.noise, ps=state.ps, N=state.N, scale=state.scale, rng=state.rng;
      var dpr=ctx.oledDPR||1;

      // fade-to-black trails: low-alpha black keeps the vast majority of pixels
      // near true black (low average luminance, burn-in safe) and lets streaks decay
      ctx.globalCompositeOperation="source-over";
      ctx.globalAlpha=1;
      ctx.lineWidth=1;
      ctx.fillStyle=P3(ctx,0,0,0,0.09);
      ctx.fillRect(0,0,w,h);

      // additive luminous strokes (saturated colored light on black, never a white wall)
      ctx.globalCompositeOperation="lighter";
      ctx.lineCap="round";

      var zt=t*0.045;                 // slow field evolution (animated 3rd dimension)
      var baseSpeed=52;               // px/sec base drift -> nothing pins
      var hueGlobal=t*0.055;          // continuous full-wheel sweep over time
      // finite-difference sampling step ~ half a grid cell (real curl, not sub-pixel noise)
      var fd=0.5;
      // crisp line: ~1.3 CSS px, with a fine-detail floor of 1 device px
      var lwBase=Math.max(1/dpr, 1.3);

      for(var i=0;i<N;i++){
        var p=ps[i];

        var nx=p.x*scale, ny=p.y*scale;
        // curl of a scalar potential field -> divergence-free (river-like) flow
        var n_yp=noise(nx, ny+fd + zt);
        var n_ym=noise(nx, ny-fd + zt);
        var n_xp=noise(nx+fd, ny + zt);
        var n_xm=noise(nx-fd, ny + zt);
        var vx=(n_yp-n_ym);
        var vy=-(n_xp-n_xm);
        var mag=Math.sqrt(vx*vx+vy*vy)+1e-6;
        vx/=mag; vy/=mag;

        p.px=p.x; p.py=p.y;
        var step=baseSpeed*p.spd*dt;
        p.x+=vx*step;
        p.y+=vy*step;
        p.life+=dt;

        // respawn on edge exit or end of life (persisted PRNG, never Math.random in draw)
        var dead = p.life>p.maxlife || p.x<-24||p.x>w+24||p.y<-24||p.y>h+24;
        if(dead){
          p.x=rng()*w; p.y=rng()*h;
          p.px=p.x; p.py=p.y;
          p.life=0; p.maxlife=7+rng()*9;
          p.hueOff=rng();
          p.spd=0.7+rng()*0.7;
          p.size=0.6+rng()*1.2;
          continue;
        }

        // hue: full-wheel cycle over time + spatial gradient + per-particle offset
        var hue = hueGlobal + p.hueOff + (p.x+p.y)*0.0007 + p.life*0.06;
        var rgb=hsl2rgb(hue, 1.0, 0.52); // fully saturated, mid lightness (no white-out)

        // gentle fade in/out across lifetime -> no harsh luminance jumps / strobing
        var lifeT=p.life/p.maxlife;
        var env=Math.sin((lifeT<0?0:lifeT>1?1:lifeT)*Math.PI); // 0..1..0
        var aLine=0.20*env;
        var aGlow=0.42*env;

        // streak from previous to current position
        ctx.strokeStyle=P3(ctx,rgb[0],rgb[1],rgb[2],aLine);
        ctx.lineWidth=lwBase*(0.7+p.size*0.5);
        ctx.beginPath();
        ctx.moveTo(p.px,p.py);
        ctx.lineTo(p.x,p.y);
        ctx.stroke();

        // small crisp head
        ctx.fillStyle=P3(ctx,rgb[0],rgb[1],rgb[2],aGlow);
        var r=Math.max(1/dpr, p.size*0.85);
        ctx.beginPath();
        ctx.arc(p.x,p.y,r,0,6.2831853);
        ctx.fill();
      }

      // leave ctx clean
      ctx.globalCompositeOperation="source-over";
      ctx.globalAlpha=1;
      ctx.lineWidth=1;
    }
  });
})();