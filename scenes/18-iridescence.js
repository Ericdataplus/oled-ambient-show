/* Iridescence — smooth oil-slick / thin-film interference rendered with a WebGL
   fragment shader (full-spectrum, wide-gamut display-p3 when available), composited
   into the 2D pipeline. Falls back to soft drifting Canvas2D color blobs if WebGL is
   unavailable. Animation is bounded (sin/cos) so it stays precise over a 24/7 run, and
   the bands continuously flow + drift for burn-in safety. No blocky cells. */
(function () {
  "use strict";

  var VERT = "attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}";

  var FRAG = [
    "precision highp float;",
    "uniform vec2 u_res;uniform float u_time;",
    "float hash(vec2 p){p=fract(p*vec2(127.1,311.7));p+=dot(p,p+34.53);return fract(p.x*p.y);}",
    "float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);",
    " float a=hash(i),b=hash(i+vec2(1.0,0.0)),c=hash(i+vec2(0.0,1.0)),d=hash(i+vec2(1.0,1.0));",
    " return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}",
    "float fbm(vec2 p){float v=0.0,a=0.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);",
    " for(int i=0;i<5;i++){v+=a*noise(p);p=m*p+0.02;a*=0.5;}return v;}",
    "void main(){",
    " vec2 p=(gl_FragCoord.xy-0.5*u_res)/u_res.y;",
    " float tt=u_time;",
    " vec2 q=vec2(fbm(p*1.6+0.5*sin(tt*0.05)),fbm(p*1.6+vec2(2.7,4.3)+0.5*cos(tt*0.043)));",
    " vec2 d=vec2(sin(tt*0.020),cos(tt*0.016))*0.4;",            // bounded global drift
    " float thick=fbm(p*2.2+2.5*q+0.3*vec2(sin(tt*0.030),cos(tt*0.027)))+0.15*fbm((p+d)*1.1);",
    " float hue=thick*2.4+tt*0.04+length(q)*0.4;",               // thin-film -> many spectrum cycles
    " vec3 col=0.5+0.5*cos(6.28318*(hue+vec3(0.0,0.3333,0.6667)));", // smooth full-spectrum palette
    " float band=0.5+0.5*cos(thick*16.0+tt*0.15); band=pow(band,1.85);", // interference crests
    " float mask=smoothstep(0.10,0.74,fbm(p*1.3-0.1*d));",       // keep blacks, no uniform wall
    " float inten=band*mask;",
    " col*=inten*0.95; col=max(col-0.010,0.0);",
    " col*=mix(0.70,1.0,smoothstep(1.30,0.20,length(p)));",      // gentle vignette
    " gl_FragColor=vec4(col,1.0);",
    "}"
  ].join("\n");

  function compile(gl, type, src) {
    var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
    return sh;
  }
  function buildGL(buf, wantP3) {
    var gl = null;
    var opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false, failIfMajorPerformanceCaveat: false };
    try { gl = buf.getContext("webgl", opts) || buf.getContext("experimental-webgl", opts); } catch (e) { gl = null; }
    if (!gl) return null;
    if (wantP3) { try { gl.drawingBufferColorSpace = "display-p3"; } catch (e) {} }
    var vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    var prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    var vbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return { gl: gl, uRes: gl.getUniformLocation(prog, "u_res"), uTime: gl.getUniformLocation(prog, "u_time") };
  }

  /* ---- color helpers + Canvas2D fallback (smooth drifting rainbow blobs) ---- */
  function P3(ctx, r, g, b, a) {
    if (a === undefined) a = 1;
    if (ctx.oledWideGamut) return "color(display-p3 " + r.toFixed(4) + " " + g.toFixed(4) + " " + b.toFixed(4) + " / " + a.toFixed(4) + ")";
    return "rgba(" + ((r * 255) | 0) + "," + ((g * 255) | 0) + "," + ((b * 255) | 0) + "," + a.toFixed(4) + ")";
  }
  function hsl2rgb(h, s, l) {
    h = ((h % 1) + 1) % 1; var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = l - c / 2, r = 0, g = 0, b = 0, k = Math.floor(h * 6);
    if (k === 0) { r = c; g = x; } else if (k === 1) { r = x; g = c; } else if (k === 2) { g = c; b = x; } else if (k === 3) { g = x; b = c; } else if (k === 4) { r = x; b = c; } else { r = c; b = x; }
    return [r + m, g + m, b + m];
  }
  function rng(seed) { var s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function fallbackSetup(w, h) {
    var R = rng(0x1deecaf), md = Math.min(w, h), blobs = [], i;
    for (i = 0; i < 7; i++) {
      var ang = R() * 6.283;
      blobs.push({ x: R() * w, y: R() * h, r: md * (0.3 + R() * 0.4), hue: R(), hs: 0.03 + R() * 0.04,
        vx: Math.cos(ang) * md * 0.005, vy: Math.sin(ang) * md * 0.005, ph: R() * 6.283, ps: 0.03 + R() * 0.05 });
    }
    return { mode: "2d", blobs: blobs };
  }
  function fallbackDraw(ctx, w, h, t, dt, s) {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    var mx = w * 0.3, my = h * 0.3, i, b, c2;
    for (i = 0; i < s.blobs.length; i++) {
      b = s.blobs[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -mx) b.x = w + mx; else if (b.x > w + mx) b.x = -mx;
      if (b.y < -my) b.y = h + my; else if (b.y > h + my) b.y = -my;
      var a = (0.07 + 0.05 * (0.5 + 0.5 * Math.sin(t * b.ps * 6.283 + b.ph)));
      c2 = hsl2rgb(t * b.hs + b.hue, 0.95, 0.5);
      var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, P3(ctx, c2[0], c2[1], c2[2], a));
      g.addColorStop(1, P3(ctx, c2[0], c2[1], c2[2], 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  }

  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "Iridescence",

    setup: function (ctx, w, h) {
      if (w <= 0 || h <= 0) return { mode: "2d", bad: true };
      var pw = (ctx.canvas && ctx.canvas.width) ? ctx.canvas.width : Math.round(w);
      var ph = (ctx.canvas && ctx.canvas.height) ? ctx.canvas.height : Math.round(h);
      var fb = fallbackSetup(w, h);
      var buf = document.createElement("canvas"); buf.width = Math.max(2, pw); buf.height = Math.max(2, ph);
      var g = buildGL(buf, !!ctx.oledWideGamut);
      if (!g) return fb;
      var state = { mode: "gl", g: g, buf: buf, fb: fb };
      buf.addEventListener("webglcontextlost", function (e) { e.preventDefault(); state.mode = "2d"; }, false);
      return state;
    },

    draw: function (ctx, w, h, t, dt, state) {
      if (!state || state.bad || w <= 0 || h <= 0) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); return; }
      if (!(dt > 0)) dt = 0; if (dt > 0.1) dt = 0.1;
      if (state.mode !== "gl") { fallbackDraw(ctx, w, h, t, dt, state.blobs ? state : state.fb); return; }
      var g = state.g, gl = g.gl, buf = state.buf;
      try {
        gl.viewport(0, 0, buf.width, buf.height);
        gl.uniform2f(g.uRes, buf.width, buf.height);
        gl.uniform1f(g.uTime, t);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(buf, 0, 0, w, h);
      } catch (e) { state.mode = "2d"; fallbackDraw(ctx, w, h, t, dt, state.fb); }
    },

    teardown: function (state) {
      if (state && state.g && state.g.gl) {
        var ext = state.g.gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
    }
  });
})();
