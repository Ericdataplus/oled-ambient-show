/* =====================================================================
   OLED Ambient Show — Engine
   Burn-in-safe generative ambient display for an always-on OLED screen.

   The engine handles everything EXCEPT the art itself:
     - true-black fullscreen canvas
     - compositor-level pixel-orbit (every pixel slowly drifts -> no burn-in)
     - master brightness + automatic night-time dimming
     - smooth crossfading scene cycler (shuffled, never repeats back-to-back)
     - auto-hidden cursor + auto-hiding help overlay (no static UI)
     - keyboard controls for tinkering

   Scenes live in scenes/*.js and register themselves on window.OLED_SCENES.
   ===================================================================== */
(function () {
  "use strict";

  /* ------------------------- TINKER HERE ------------------------------ */
  var CONFIG = {
    dwellSeconds: 55,      // base seconds each scene shows before auto-advancing
    dwellJitter: 20,       // +/- random seconds, so the rotation never feels metronomic
    crossfadeSeconds: 4,   // length of the dissolve between scenes
    brightness: 0.85,      // 0..1 master software brightness (set MONITOR brightness low too)
    nightDimming: true,    // dim further late at night
    orbitAmplitude: 14,    // px the whole image slowly drifts (burn-in shield)
    overscan: 48,          // px the canvas extends past the screen (hides orbit edges)
    maxDPR: 3,             // cap device-pixel-ratio (3 = always render this 170-PPI panel natively)
    renderScale: 1.5,      // SSAA: render >1 then downscale for razor-sharp fine detail.
                           //   1.0 = native (fast) · 1.5 = crisp (default) · 2.0 = ultra (heavier)
    shuffle: true,         // randomized, non-repeating scene order
    showClock: false,      // optional drifting dim clock (off by default)
    cursorIdleMs: 2000,    // hide cursor after this much mouse stillness
    helpVisibleMs: 9000    // auto-hide the help overlay after load
  };
  /* -------------------------------------------------------------------- */

  var stage, sctx, dpr, pxScale;
  var vw = 0, vh = 0, cw = 0, ch = 0;     // viewport + canvas (CSS px), canvas = viewport + overscan
  var pw = 0, ph = 0;                       // canvas backing-store size (device px * renderScale)
  var scenes = [];                          // registered scene defs
  var order = [], orderPos = 0;             // play order
  var current = null, outgoing = null;      // live scene instances
  var transStart = 0, transitioning = false;
  var sceneStart = 0, lastFrame = 0, currentDwell = 55;
  var paused = false, brightness = CONFIG.brightness;
  var dimEl, helpEl, clockEl, hintEl;
  var lastMouse = 0;
  var rafId = 0;

  function now() { return performance.now() / 1000; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }

  /* ---------- canvas sizing ---------- */
  function sizeStage() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    cw = vw + CONFIG.overscan;
    ch = vh + CONFIG.overscan;
    dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDPR);
    // Backing store is the panel's true device pixels times the SSAA factor.
    // The element is then CSS-sized to the viewport, so the browser downsamples
    // the extra samples into buttery-smooth, crisp fine detail on the dense panel.
    pxScale = dpr * CONFIG.renderScale;
    pw = Math.round(cw * pxScale);
    ph = Math.round(ch * pxScale);

    stage.width = pw;
    stage.height = ph;
    stage.style.width = cw + "px";
    stage.style.height = ch + "px";
    stage.style.left = (-CONFIG.overscan / 2) + "px";
    stage.style.top = (-CONFIG.overscan / 2) + "px";
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";

    // re-create offscreen buffers for any live scenes
    if (current) reflowScene(current);
    if (outgoing) reflowScene(outgoing);
  }

  function makeBuffer() {
    var c = document.createElement("canvas");
    c.width = pw; c.height = ph;
    var x = c.getContext("2d");
    return { canvas: c, ctx: x };
  }

  function reflowScene(inst) {
    var buf = makeBuffer();
    inst.canvas = buf.canvas;
    inst.ctx = buf.ctx;
    inst.ctx.setTransform(pxScale, 0, 0, pxScale, 0, 0);
    inst.ctx.imageSmoothingEnabled = true;
    inst.ctx.imageSmoothingQuality = "high";
    // Scenes draw in CSS px. oledDPR is the PHYSICAL device-pixel ratio, so a
    // scene's "1 device pixel" (lineWidth/size = 1/ctx.oledDPR) maps to exactly
    // one real screen pixel at full brightness after the SSAA buffer downscales
    // — crisp AND bright, instead of sub-pixel-thin and dim.
    inst.ctx.oledDPR = dpr;
    try { inst.state = inst.def.setup ? inst.def.setup(inst.ctx, cw, ch) : {}; }
    catch (e) { console.error("setup failed:", inst.def.name, e); inst.state = {}; }
  }

  function makeScene(def) {
    var inst = { def: def, canvas: null, ctx: null, state: null, start: now() };
    reflowScene(inst);
    return inst;
  }

  /* ---------- scene order ---------- */
  function buildOrder() {
    order = scenes.map(function (_, i) { return i; });
    if (CONFIG.shuffle) {
      for (var i = order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = order[i]; order[i] = order[j]; order[j] = t;
      }
    }
    orderPos = 0;
  }

  function gotoScene(idx, immediate) {
    if (!scenes.length) return;
    var def = scenes[((idx % scenes.length) + scenes.length) % scenes.length];
    var next = makeScene(def);
    if (current && !immediate) {
      outgoing = current;
      transitioning = true;
      transStart = now();
    } else {
      current && (current = null);
      outgoing = null;
      transitioning = false;
    }
    current = next;
    sceneStart = now();
    currentDwell = CONFIG.dwellSeconds + (Math.random() * 2 - 1) * CONFIG.dwellJitter;
    flashHint(def.name);
  }

  function advance(dir) {
    if (!scenes.length) return;
    orderPos = (orderPos + (dir || 1) + order.length) % order.length;
    gotoScene(order[orderPos], false);
  }

  /* ---------- night dimming ---------- */
  function nightFactor() {
    if (!CONFIG.nightDimming) return 1;
    var h = new Date().getHours() + new Date().getMinutes() / 60;
    // full brightness 8:00-20:00, dip to 0.55 around 02:00, smooth cosine
    var dayMid = 14;                       // brightest hour
    var ang = ((h - dayMid) / 24) * Math.PI * 2;
    var f = 0.85 + 0.15 * Math.cos(ang);   // 0.70 .. 1.0 (gentle)
    return clamp(f, 0.70, 1);
  }

  /* ---------- main loop ---------- */
  function frame() {
    rafId = requestAnimationFrame(frame);
    if (paused) return;

    var tNow = now();
    var dt = lastFrame ? Math.min(tNow - lastFrame, 0.1) : 0.016;
    lastFrame = tNow;

    // pixel-orbit: slow Lissajous, two near-coprime periods so it never visibly repeats
    var ox = Math.sin(tNow * (2 * Math.PI / 660)) * CONFIG.orbitAmplitude;
    var oy = Math.cos(tNow * (2 * Math.PI / 410)) * CONFIG.orbitAmplitude;
    stage.style.transform = "translate(" + ox.toFixed(2) + "px," + oy.toFixed(2) + "px)";

    // render live scenes onto their own buffers
    drawScene(current, tNow, dt);
    if (transitioning && outgoing) drawScene(outgoing, tNow, dt);

    // composite to stage
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, pw, ph);

    if (transitioning && outgoing) {
      var p = clamp((tNow - transStart) / CONFIG.crossfadeSeconds, 0, 1);
      var e = easeInOut(p);
      sctx.globalAlpha = 1 - e;
      sctx.drawImage(outgoing.canvas, 0, 0);
      sctx.globalAlpha = e;
      sctx.drawImage(current.canvas, 0, 0);
      sctx.globalAlpha = 1;
      if (p >= 1) { transitioning = false; outgoing = null; }
    } else if (current) {
      sctx.drawImage(current.canvas, 0, 0);
    }

    // brightness + night dim via overlay opacity
    var eff = brightness * nightFactor();
    dimEl.style.opacity = (1 - clamp(eff, 0.05, 1)).toFixed(3);

    // optional drifting clock
    if (CONFIG.showClock) updateClock(tNow);

    // auto-advance
    if (!transitioning && (tNow - sceneStart) > currentDwell) advance(1);

    // cursor idle hide
    if (tNow * 1000 - lastMouse > CONFIG.cursorIdleMs) document.body.style.cursor = "none";
  }

  function drawScene(inst, tNow, dt) {
    if (!inst || cw <= 0 || ch <= 0) return;
    var t = tNow - inst.start;
    try { inst.def.draw(inst.ctx, cw, ch, t, dt, inst.state); }
    catch (e) {
      console.error("draw failed:", inst.def.name, e);
      // fail safe: paint black so a broken scene can't burn a frozen image
      inst.ctx.setTransform(1, 0, 0, 1, 0, 0);
      inst.ctx.fillStyle = "#000"; inst.ctx.fillRect(0, 0, pw, ph);
      inst.ctx.setTransform(pxScale, 0, 0, pxScale, 0, 0);
    }
  }

  /* ---------- clock (optional, dim + drifting => burn-in safe) ---------- */
  function updateClock(tNow) {
    var d = new Date();
    var hh = d.getHours(), mm = d.getMinutes();
    var ap = hh >= 12 ? "PM" : "AM";
    var h12 = hh % 12; if (h12 === 0) h12 = 12;
    clockEl.textContent = h12 + ":" + (mm < 10 ? "0" + mm : mm) + " " + ap;
    // drift slowly around the center third of the screen
    var x = 50 + 18 * Math.sin(tNow * (2 * Math.PI / 240));
    var y = 50 + 14 * Math.cos(tNow * (2 * Math.PI / 175));
    clockEl.style.left = x + "%";
    clockEl.style.top = y + "%";
  }

  /* ---------- transient hint (scene name) ---------- */
  var hintTimer = 0;
  function flashHint(text) {
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.style.opacity = "0.85";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hintEl.style.opacity = "0"; }, 2600);
  }

  /* ---------- input ---------- */
  function onKey(e) {
    switch (e.key) {
      case " ": case "ArrowRight": e.preventDefault(); advance(1); break;
      case "ArrowLeft": e.preventDefault(); advance(-1); break;
      case "ArrowUp": brightness = clamp(brightness + 0.05, 0.1, 1); flashHint("Brightness " + Math.round(brightness * 100) + "%"); break;
      case "ArrowDown": brightness = clamp(brightness - 0.05, 0.1, 1); flashHint("Brightness " + Math.round(brightness * 100) + "%"); break;
      case "p": case "P": paused = !paused; flashHint(paused ? "Paused" : "Playing"); break;
      case "c": case "C": CONFIG.showClock = !CONFIG.showClock; clockEl.style.display = CONFIG.showClock ? "block" : "none"; break;
      case "h": case "H": case "?": toggleHelp(); break;
      case "s": case "S": buildOrder(); advance(0); flashHint("Reshuffled"); break;
    }
  }

  function onMouse() {
    lastMouse = performance.now();
    document.body.style.cursor = "default";
  }

  function toggleHelp() {
    var on = helpEl.style.opacity !== "0" && helpEl.dataset.shown === "1";
    helpEl.dataset.shown = on ? "0" : "1";
    helpEl.style.opacity = on ? "0" : "1";
  }

  /* ---------- build DOM ---------- */
  function build() {
    document.body.style.margin = "0";
    document.body.style.background = "#000";
    document.body.style.overflow = "hidden";
    document.documentElement.style.background = "#000";

    stage = document.createElement("canvas");
    stage.style.position = "fixed";
    stage.style.willChange = "transform";
    stage.style.background = "#000";
    document.body.appendChild(stage);
    sctx = stage.getContext("2d");

    dimEl = document.createElement("div");
    dimEl.style.cssText = "position:fixed;inset:0;background:#000;pointer-events:none;z-index:10;transition:opacity .8s ease;";
    document.body.appendChild(dimEl);

    clockEl = document.createElement("div");
    clockEl.style.cssText = "position:fixed;transform:translate(-50%,-50%);color:rgba(255,255,255,.42);" +
      "font:300 5vmin 'Segoe UI',system-ui,sans-serif;letter-spacing:.08em;pointer-events:none;z-index:11;" +
      "text-shadow:0 0 18px rgba(120,180,255,.25);display:" + (CONFIG.showClock ? "block" : "none") + ";";
    document.body.appendChild(clockEl);

    hintEl = document.createElement("div");
    hintEl.style.cssText = "position:fixed;left:50%;bottom:6vh;transform:translateX(-50%);color:rgba(255,255,255,.6);" +
      "font:300 2.4vmin 'Segoe UI',system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase;" +
      "pointer-events:none;z-index:12;opacity:0;transition:opacity .9s ease;";
    document.body.appendChild(hintEl);

    helpEl = document.createElement("div");
    helpEl.dataset.shown = "1";
    helpEl.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:13;" +
      "color:rgba(255,255,255,.78);background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);" +
      "border-radius:14px;padding:22px 28px;font:300 2.1vmin 'Segoe UI',system-ui,sans-serif;line-height:1.7;" +
      "letter-spacing:.03em;pointer-events:none;text-align:center;transition:opacity 1.2s ease;backdrop-filter:blur(4px);";
    helpEl.innerHTML =
      "<div style='font-size:1.3em;letter-spacing:.12em;margin-bottom:10px'>OLED AMBIENT SHOW</div>" +
      "<div style='opacity:.85'>Press <b>F11</b> for fullscreen</div>" +
      "<div style='opacity:.6;margin-top:14px;font-size:.92em'>" +
      "Space / &rarr; next &nbsp;·&nbsp; &larr; previous &nbsp;·&nbsp; &uarr;&darr; brightness<br>" +
      "S shuffle &nbsp;·&nbsp; P pause &nbsp;·&nbsp; C clock &nbsp;·&nbsp; H this help</div>" +
      "<div style='opacity:.4;margin-top:14px;font-size:.82em'>burn-in shield active · pixel-orbit + auto-dim</div>";
    document.body.appendChild(helpEl);
    setTimeout(function () { if (helpEl.dataset.shown === "1") { helpEl.dataset.shown = "0"; helpEl.style.opacity = "0"; } }, CONFIG.helpVisibleMs);
  }

  /* ---------- boot ---------- */
  function boot() {
    build();
    scenes = (window.OLED_SCENES || []).filter(function (s) { return s && typeof s.draw === "function"; });
    sizeStage();

    if (!scenes.length) {
      // nothing registered — show a gentle built-in fallback so the screen is never dead
      scenes = [fallbackScene()];
    }
    buildOrder();
    gotoScene(order[0], true);

    window.addEventListener("resize", sizeStage);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMouse);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { paused = true; }
      else { paused = false; lastFrame = 0; }
    });

    lastMouse = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  /* gentle built-in fallback (also a template for what a scene looks like) */
  function fallbackScene() {
    return {
      name: "Aurora Breath",
      setup: function (ctx, w, h) { return { hue: 200 }; },
      draw: function (ctx, w, h, t, dt, s) {
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";
        var bands = 5;
        for (var i = 0; i < bands; i++) {
          var ph = t * 0.15 + i * 1.3;
          var cy = h * (0.35 + 0.3 * Math.sin(ph * 0.6 + i));
          var g = ctx.createRadialGradient(w / 2, cy, 0, w / 2, cy, h * 0.7);
          var hue = (s.hue + i * 30 + t * 6) % 360;
          g.addColorStop(0, "hsla(" + hue + ",90%,55%,0.10)");
          g.addColorStop(1, "hsla(" + hue + ",90%,55%,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          for (var x = 0; x <= w; x += 24) {
            var y = cy + Math.sin(x * 0.004 + ph) * h * 0.12;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
