/* Deep Nebula (realtime) — a photo-plausible volumetric nebula rendered with a
   WebGL fractal-noise + domain-warp fragment shader, composited into the 2D
   pipeline via drawImage. Falls back to a soft Canvas2D nebula if WebGL is
   unavailable (older TVs, context loss). Animation is kept BOUNDED (sin/cos, no
   unbounded coordinate drift) so it stays crisp over an all-night run, and the
   bright filaments continuously relocate (domain warp) for burn-in safety. */
(function () {
  "use strict";

  var VERT =
    "attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}";

  var FRAG = [
    "precision highp float;",
    "uniform vec2 u_res;",
    "uniform float u_time;",
    "float hash(vec2 p){p=fract(p*vec2(127.1,311.7));p+=dot(p,p+34.53);return fract(p.x*p.y);}",
    "float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);",
    " float a=hash(i),b=hash(i+vec2(1.0,0.0)),c=hash(i+vec2(0.0,1.0)),d=hash(i+vec2(1.0,1.0));",
    " return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}",
    "float fbm(vec2 p){float v=0.0,a=0.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);",
    " for(int i=0;i<6;i++){v+=a*noise(p);p=m*p+0.02;a*=0.5;}return v;}",
    "void main(){",
    " vec2 uv=gl_FragCoord.xy/u_res.xy;",
    " vec2 p=(gl_FragCoord.xy-0.5*u_res.xy)/u_res.y;",
    " vec2 drift=vec2(sin(u_time*0.013),cos(u_time*0.0091))*0.55;",   // bounded slow sway
    " p=p*1.55+drift;",
    " vec2 q=vec2(fbm(p+vec2(0.0,0.0)+0.55*sin(u_time*0.021)),fbm(p+vec2(5.2,1.3)+0.55*cos(u_time*0.017)));",
    " vec2 r=vec2(fbm(p+3.0*q+vec2(1.7,9.2)),fbm(p+3.0*q+vec2(8.3,2.8)));",
    " float f=fbm(p+3.0*r);",
    " float d=pow(clamp(f,0.0,1.0),1.7);",
    " float clump=clamp(dot(q,q),0.0,1.0);",
    " vec3 col=vec3(0.0);",
    " col+=vec3(0.08,0.16,0.40)*smoothstep(0.15,0.70,d);",   // cool teal/blue gas
    " col+=vec3(0.50,0.10,0.32)*smoothstep(0.45,0.95,d);",   // magenta/red emission
    " col+=vec3(0.95,0.72,0.42)*smoothstep(0.80,1.08,d);",   // hot gold cores
    " col+=vec3(0.35,0.06,0.10)*clump*0.45;",                // dusty red clumps
    " col*=0.85; col=max(col-0.015,0.0);",                   // keep deep blacks
    " float st=0.0;",
    " vec2 suv=uv+drift*0.03;",
    " for(int k=0;k<3;k++){float sc=180.0+float(k)*260.0;vec2 g=suv*sc*vec2(u_res.x/u_res.y,1.0);",
    "  vec2 gi=floor(g);float h=hash(gi+float(k)*23.0);",
    "  float s=step(0.9965,h);float tw=0.55+0.45*sin(u_time*(0.8+h*2.5)+h*40.0);",
    "  st+=s*tw*(0.9-float(k)*0.22);}",
    " col+=vec3(0.85,0.90,1.0)*st;",
    " float vig=smoothstep(1.45,0.25,length(p));",
    " col*=mix(0.62,1.0,vig);",
    " gl_FragColor=vec4(col,1.0);",
    "}"
  ].join("\n");

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
    return sh;
  }

  function buildGL(buf) {
    var gl = null;
    var opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false, failIfMajorPerformanceCaveat: false };
    try { gl = buf.getContext("webgl", opts) || buf.getContext("experimental-webgl", opts); } catch (e) { gl = null; }
    if (!gl) return null;
    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    var vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return { gl: gl, uRes: gl.getUniformLocation(prog, "u_res"), uTime: gl.getUniformLocation(prog, "u_time") };
  }

  /* ---- Canvas2D fallback nebula (used if WebGL is unavailable) ---- */
  function rng(seed) { var s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function fallbackSetup(w, h) {
    var R = rng(0x51deba11), md = Math.min(w, h), i;
    var pal = [[40, 80, 150], [150, 40, 110], [180, 130, 70], [60, 40, 140]];
    var blobs = [];
    for (i = 0; i < 7; i++) {
      var ang = R() * 6.283;
      blobs.push({ x: R() * w, y: R() * h, r: md * (0.3 + R() * 0.45), c: pal[(R() * pal.length) | 0],
        a: 0.04 + R() * 0.04, vx: Math.cos(ang) * md * 0.004, vy: Math.sin(ang) * md * 0.004,
        ph: R() * 6.283, ps: 0.02 + R() * 0.04 });
    }
    var stars = [];
    var n = Math.max(120, Math.min(1400, Math.floor(w * h * 0.0006)));
    for (i = 0; i < n; i++) stars.push({ x: R() * w, y: R() * h, r: 0.4 + Math.pow(R(), 3) * 1.6, b: 0.2 + Math.pow(R(), 2) * 0.8, tp: R() * 6.283, ts: 0.3 + R() * 1.2 });
    return { mode: "2d", blobs: blobs, stars: stars };
  }
  function fallbackDraw(ctx, w, h, t, dt, s) {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    var i, mx = w * 0.3, my = h * 0.3, b;
    for (i = 0; i < s.blobs.length; i++) {
      b = s.blobs[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -mx) b.x = w + mx; else if (b.x > w + mx) b.x = -mx;
      if (b.y < -my) b.y = h + my; else if (b.y > h + my) b.y = -my;
      var a = b.a * (0.6 + 0.4 * Math.sin(t * b.ps * 6.283 + b.ph));
      var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, "rgba(" + b.c[0] + "," + b.c[1] + "," + b.c[2] + "," + a.toFixed(4) + ")");
      g.addColorStop(1, "rgba(" + b.c[0] + "," + b.c[1] + "," + b.c[2] + ",0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.283); ctx.fill();
    }
    for (i = 0; i < s.stars.length; i++) {
      var st = s.stars[i];
      var bb = st.b * (0.6 + 0.4 * Math.sin(t * st.ts + st.tp));
      ctx.globalAlpha = bb < 0 ? 0 : (bb > 1 ? 1 : bb);
      ctx.fillStyle = "#dfe8ff";
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Deep Nebula",

    setup: function (ctx, w, h) {
      if (w <= 0 || h <= 0) return { mode: "2d", bad: true };
      // size the GL buffer to the (possibly supersampled) 2D buffer for a 1:1 blit
      var pw = (ctx.canvas && ctx.canvas.width) ? ctx.canvas.width : Math.round(w);
      var ph = (ctx.canvas && ctx.canvas.height) ? ctx.canvas.height : Math.round(h);
      var fb = fallbackSetup(w, h);              // always have a fallback ready (e.g. context loss)
      var buf = document.createElement("canvas");
      buf.width = Math.max(2, pw); buf.height = Math.max(2, ph);
      var g = buildGL(buf);
      if (!g) return fb;
      // if the GL context is ever lost, drop to the 2D fallback
      buf.addEventListener("webglcontextlost", function (e) { e.preventDefault(); state.mode = "2d"; }, false);
      var state = { mode: "gl", g: g, buf: buf, fb: fb };
      return state;
    },

    draw: function (ctx, w, h, t, dt, state) {
      if (!state || state.bad || w <= 0 || h <= 0) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); return; }
      if (!(dt > 0)) dt = 0; if (dt > 0.1) dt = 0.1;
      if (state.mode !== "gl") { fallbackDraw(ctx, w, h, t, dt, state.mode === "2d" && state.blobs ? state : state.fb); return; }

      var g = state.g, gl = g.gl, buf = state.buf;
      try {
        gl.viewport(0, 0, buf.width, buf.height);
        gl.uniform2f(g.uRes, buf.width, buf.height);
        gl.uniform1f(g.uTime, t);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(buf, 0, 0, w, h);
      } catch (e) {
        state.mode = "2d";
        fallbackDraw(ctx, w, h, t, dt, state.fb);
      }
    },

    teardown: function (state) {
      if (state && state.g && state.g.gl) {
        var ext = state.g.gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
    }
  });
})();
