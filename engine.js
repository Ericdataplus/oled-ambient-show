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
    autoQuality: true,     // auto-lower render scale if the device can't hold a smooth frame rate
    minRenderScale: 0.75,  // floor the auto-quality guard won't drop below
    shuffle: true,         // randomized, non-repeating scene order
    lock: false,           // stay on ONE scene instead of auto-rotating (toggle live with the L key)
    startScene: null,      // start on a specific scene by name or index (also via ?scene= / ?only=)
    infoMode: 0,           // overlay: 0 off · 1 clock · 2 clock+seconds · 3 clock+date+moon (cycle with C)
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
  var infoMode = CONFIG.infoMode;
  var geo = null, weather = null, iss = null, geoTried = false, lastWx = 0, lastISS = 0;
  var pomo = null, sw = { running: false, base: 0, acc: 0 };   // focus timer + stopwatch
  var dimEl, helpEl, infoEl, toolEl, hintEl;
  var lastMouse = 0;
  var rafId = 0;
  var autoScale = 1;                         // auto-quality multiplier on top of CONFIG.renderScale
  var fpsAccum = 0, fpsFrames = 0, fpsWinStart = 0, qualityCooldown = 0;
  var locked = false;                        // when true, stay on the current scene (no auto-advance)
  var COLOR_SPACE = "srgb", wideGamut = false; // display-p3 wide gamut when the browser supports it

  // Detect wide-gamut canvas support so scenes can paint colors beyond sRGB on the OLED.
  function detectColorSpace() {
    try {
      var c = document.createElement("canvas");
      var x = c.getContext("2d", { colorSpace: "display-p3" });
      if (x && x.getContextAttributes && x.getContextAttributes().colorSpace === "display-p3") {
        COLOR_SPACE = "display-p3"; wideGamut = true;
      }
    } catch (e) { /* old browser: stay sRGB */ }
  }

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
    pxScale = dpr * CONFIG.renderScale * autoScale;
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
    var x = c.getContext("2d", { colorSpace: COLOR_SPACE });
    return { canvas: c, ctx: x };
  }

  function reflowScene(inst) {
    if (inst.state) disposeScene(inst);   // release old GL context before rebuilding (e.g. on resize)
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
    inst.ctx.oledWideGamut = wideGamut;   // scenes use display-p3 colors when true
    try { inst.state = inst.def.setup ? inst.def.setup(inst.ctx, cw, ch) : {}; }
    catch (e) { console.error("setup failed:", inst.def.name, e); inst.state = {}; }
  }

  function makeScene(def) {
    var inst = { def: def, canvas: null, ctx: null, state: null, start: now() };
    reflowScene(inst);
    return inst;
  }

  // Let scenes release resources (e.g. a WebGL context) when they're discarded,
  // so an all-day run cycling through shader scenes never leaks GL contexts.
  function disposeScene(inst) {
    if (inst && inst.def && inst.def.teardown) { try { inst.def.teardown(inst.state); } catch (e) {} }
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
      if (outgoing) disposeScene(outgoing);   // rapid manual next: drop the prior outgoing
      outgoing = current;
      transitioning = true;
      transStart = now();
    } else {
      if (current) disposeScene(current);
      current = null;
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
    var rawDt = lastFrame ? (tNow - lastFrame) : 0.016;
    var dt = Math.min(rawDt, 0.1);
    lastFrame = tNow;
    autoQualityTick(tNow, rawDt);

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
      if (p >= 1) { transitioning = false; disposeScene(outgoing); outgoing = null; }
    } else if (current) {
      sctx.drawImage(current.canvas, 0, 0);
    }

    // brightness + night dim via overlay opacity
    var eff = brightness * nightFactor();
    dimEl.style.opacity = (1 - clamp(eff, 0.05, 1)).toFixed(3);

    // info overlay (clock / dashboard) + tools (timer / stopwatch); each handles its own visibility
    updateInfo(tNow);
    updateTools(tNow);

    // auto-advance (skipped while locked on one scene)
    if (!locked && !transitioning && (tNow - sceneStart) > currentDwell) advance(1);

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

  /* ---------- auto quality: keep the frame rate smooth on weaker devices ----------
     Big 4K TVs (e.g. an LG C-series) can't render the supersampled buffer at 60fps.
     If we detect a sustained low frame rate, step the render scale down (never below
     CONFIG.minRenderScale) until it's smooth. Spikes from tab-switches are ignored. */
  function autoQualityTick(tNow, rawDt) {
    if (!CONFIG.autoQuality) return;
    if (tNow < qualityCooldown) { fpsWinStart = tNow; fpsAccum = 0; fpsFrames = 0; return; }
    if (rawDt > 0.5) return;                 // ignore tab-switch / GC hiccups
    if (!fpsWinStart) fpsWinStart = tNow;
    fpsAccum += rawDt; fpsFrames++;
    if (tNow - fpsWinStart >= 2.5 && fpsFrames > 20) {
      var fps = fpsFrames / fpsAccum;
      fpsAccum = 0; fpsFrames = 0; fpsWinStart = tNow;
      var effective = CONFIG.renderScale * autoScale;
      if (fps < 45 && effective > CONFIG.minRenderScale + 0.001) {
        var target = Math.max(CONFIG.minRenderScale, effective * 0.8);
        autoScale = target / CONFIG.renderScale;
        qualityCooldown = tNow + 3;          // let it settle before measuring again
        sizeStage();
        flashHint("Tuned for this screen · " + Math.round(target * 100) + "%");
      }
    }
  }

  /* ---------- info overlay: clock / seconds / dashboard (dim + drifting => burn-in safe) ---------- */
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  // Moon phase computed locally (no network) from a known new moon.
  function moonPhase(d) {
    var lp = 2551442.8;                                   // synodic month, seconds (29.5306 days)
    var newMoon = Date.UTC(2000, 0, 6, 18, 14, 0) / 1000;
    var frac = ((d.getTime() / 1000 - newMoon) % lp + lp) % lp / lp;  // 0..1
    var names = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous", "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"];
    var emo = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
    var i = Math.floor(frac * 8 + 0.5) % 8;
    return { name: names[i], emoji: emo[i] };
  }

  /* ---------- live data: weather + sun (open-meteo) and ISS (wheretheiss.at), free, no keys ---------- */
  function jget(u) { return fetch(u, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  function ensureGeoWeather() {
    if (geoTried) return; geoTried = true;
    jget("https://ipwho.is/").then(function (g) {
      if (g && g.success !== false && g.latitude != null) geo = { lat: g.latitude, lon: g.longitude, city: g.city || "" };
      fetchWeather();
    });
  }
  function fetchWeather() {
    if (!geo) return; lastWx = Date.now();
    jget("https://api.open-meteo.com/v1/forecast?latitude=" + geo.lat + "&longitude=" + geo.lon +
      "&current=temperature_2m,weather_code&daily=sunrise,sunset&timezone=auto&temperature_unit=fahrenheit&forecast_days=1")
      .then(function (w) {
        if (w && w.current) weather = { temp: Math.round(w.current.temperature_2m), code: w.current.weather_code,
          sunrise: w.daily && w.daily.sunrise && w.daily.sunrise[0], sunset: w.daily && w.daily.sunset && w.daily.sunset[0] };
      });
  }
  function fetchISS() {
    lastISS = Date.now();
    jget("https://api.wheretheiss.at/v1/satellites/25544").then(function (s) {
      if (s && s.latitude != null) iss = { lat: s.latitude, lon: s.longitude, alt: s.altitude };
    });
  }
  function liveTick() {                                  // runs while the full dashboard is shown
    ensureGeoWeather();
    var now = Date.now();
    if (geo && now - lastWx > 900000) fetchWeather();    // weather every 15 min
    if (now - lastISS > 5000) fetchISS();                // ISS every 5 s
  }
  function wxText(code) {
    code = +code;
    if (code === 0) return { t: "Clear", e: "☀️" };
    if (code <= 2) return { t: "Partly Cloudy", e: "⛅" };
    if (code === 3) return { t: "Overcast", e: "☁️" };
    if (code === 45 || code === 48) return { t: "Fog", e: "🌫️" };
    if (code >= 51 && code <= 67) return { t: "Rain", e: "🌧️" };
    if (code >= 71 && code <= 77) return { t: "Snow", e: "❄️" };
    if (code >= 80 && code <= 82) return { t: "Showers", e: "🌦️" };
    if (code >= 95) return { t: "Storm", e: "⛈️" };
    return { t: "—", e: "🌡️" };
  }
  function fmtISO(s) {
    if (!s) return "—"; var m = /T(\d\d):(\d\d)/.exec(s); if (!m) return "—";
    var hh = +m[1], ap = hh >= 12 ? "PM" : "AM", h12 = hh % 12 || 12; return h12 + ":" + m[2] + " " + ap;
  }
  function fmtClock(sec, centi) {
    if (sec < 0) sec = 0;
    var base = pad2(Math.floor(sec / 60)) + ":" + pad2(Math.floor(sec % 60));
    if (centi) base += "." + pad2(Math.floor((sec - Math.floor(sec)) * 100));
    return base;
  }

  var FF = "'Segoe UI',system-ui,sans-serif";
  function updateInfo(tNow) {
    if (infoMode <= 0) { if (infoEl._on) { infoEl.style.opacity = "0"; infoEl._on = false; } return; }
    if (!infoEl._on) { infoEl.style.opacity = "1"; infoEl._on = true; }
    if (infoMode >= 4) liveTick();
    var d = new Date(), hh = d.getHours(), mm = d.getMinutes(), ss = d.getSeconds();
    var ap = hh >= 12 ? "PM" : "AM", h12 = hh % 12; if (h12 === 0) h12 = 12;
    // rebuild HTML only when the shown content changes (cheap; position still drifts every frame)
    var key = infoMode + "|" + h12 + ":" + mm + (infoMode >= 2 ? ":" + ss : "") + (infoMode >= 3 ? "|" + d.getDate() : "");
    if (key !== infoEl._key) {
      infoEl._key = key;
      var sec = infoMode >= 2 ? "<span style=\"font-size:.42em;opacity:.62\">:" + pad2(ss) + "</span>" : "";
      var html = "<div style=\"font:200 7vmin " + FF + ";letter-spacing:.04em\">" + h12 + ":" + pad2(mm) + sec +
        " <span style=\"font-size:.32em;opacity:.6;font-weight:300\">" + ap + "</span></div>";
      if (infoMode >= 3) {
        var days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        var mon = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        html += "<div style=\"font:300 2.5vmin " + FF + ";opacity:.72;margin-top:.5em;letter-spacing:.16em;text-transform:uppercase\">" + days[d.getDay()] + " · " + mon[d.getMonth()] + " " + d.getDate() + "</div>";
        var mp = moonPhase(d);
        html += "<div style=\"font:300 2.1vmin " + FF + ";opacity:.6;margin-top:.55em;letter-spacing:.1em\">" + mp.emoji + " " + mp.name + "</div>";
      }
      if (infoMode >= 4) {
        if (weather) { var wc = wxText(weather.code); html += "<div style=\"font:300 2.1vmin " + FF + ";opacity:.62;margin-top:.55em;letter-spacing:.08em\">" + wc.e + " " + weather.temp + "°  " + wc.t + (geo && geo.city ? "  ·  " + geo.city : "") + "</div>"; }
        if (weather && weather.sunrise) html += "<div style=\"font:300 1.8vmin " + FF + ";opacity:.5;margin-top:.35em;letter-spacing:.08em\">🌅 " + fmtISO(weather.sunrise) + "    🌇 " + fmtISO(weather.sunset) + "</div>";
        if (iss) html += "<div style=\"font:300 1.8vmin " + FF + ";opacity:.5;margin-top:.35em;letter-spacing:.08em\">🛰 " + iss.lat.toFixed(1) + ", " + iss.lon.toFixed(1) + "  ·  " + Math.round(iss.alt) + " km</div>";
        if (!weather && !iss) html += "<div style=\"font:300 1.7vmin " + FF + ";opacity:.4;margin-top:.4em\">…live data loading…</div>";
      }
      infoEl.innerHTML = html;
    }
    var x = 50 + 16 * Math.sin(tNow * (2 * Math.PI / 240));
    var y = 50 + 12 * Math.cos(tNow * (2 * Math.PI / 175));
    infoEl.style.left = x + "%";
    infoEl.style.top = y + "%";
  }

  /* ---------- focus timer (Pomodoro 25/5) + stopwatch ---------- */
  function updateTools(tNow) {
    var lines = [];
    if (pomo && pomo.on) {
      var el = (Date.now() - pomo.startMs) / 1000, cyc = 1800, c = el % cyc, focus = c < 1500;
      lines.push((focus ? "⏳ FOCUS " : "☕ BREAK ") + fmtClock(focus ? (1500 - c) : (cyc - c)));
    }
    if (sw.running || sw.acc > 0) {
      var ms = sw.acc + (sw.running ? (Date.now() - sw.base) : 0);
      lines.push("⏱ " + fmtClock(ms / 1000, true) + (sw.running ? "" : "  ⏸"));
    }
    if (!lines.length) { if (toolEl._on) { toolEl.style.opacity = "0"; toolEl._on = false; } return; }
    if (!toolEl._on) { toolEl.style.opacity = "1"; toolEl._on = true; }
    var html = "";
    for (var i = 0; i < lines.length; i++) html += "<div style=\"font:300 3vmin " + FF + ";letter-spacing:.12em\">" + lines[i] + "</div>";
    toolEl.innerHTML = html;
    toolEl.style.left = (50 + 13 * Math.cos(tNow * (2 * Math.PI / 200))) + "%";
    toolEl.style.top = (73 + 8 * Math.sin(tNow * (2 * Math.PI / 150))) + "%";
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
      case "l": case "L": locked = !locked; flashHint(locked ? "🔒 Locked on this scene" : "Auto-rotating"); break;
      case "p": case "P": paused = !paused; flashHint(paused ? "Paused" : "Playing"); break;
      case "c": case "C": infoMode = (infoMode + 1) % 5; infoEl._key = ""; flashHint(["Info off", "Clock", "Clock + seconds", "Clock · date · moon", "Full dashboard · weather · ISS"][infoMode]); break;
      case "t": case "T":
        if (pomo && pomo.on) { pomo.on = false; flashHint("Focus timer off"); }
        else { pomo = { on: true, startMs: Date.now() }; flashHint("⏳ Focus 25:00"); }
        break;
      case "k": case "K":
        if (sw.running) { sw.acc += Date.now() - sw.base; sw.running = false; flashHint("⏱ Paused"); }
        else { sw.base = Date.now(); sw.running = true; flashHint("⏱ Stopwatch running"); }
        break;
      case "r": case "R": pomo = null; sw = { running: false, base: 0, acc: 0 }; flashHint("Timers reset"); break;
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
    sctx = stage.getContext("2d", { colorSpace: COLOR_SPACE });

    dimEl = document.createElement("div");
    dimEl.style.cssText = "position:fixed;inset:0;background:#000;pointer-events:none;z-index:10;transition:opacity .8s ease;";
    document.body.appendChild(dimEl);

    infoEl = document.createElement("div");
    infoEl.style.cssText = "position:fixed;transform:translate(-50%,-50%);text-align:center;white-space:nowrap;" +
      "color:rgba(225,232,255,.5);pointer-events:none;z-index:11;opacity:0;transition:opacity 1s ease;" +
      "text-shadow:0 0 22px rgba(120,170,255,.28);";
    infoEl._on = false; infoEl._key = "";
    document.body.appendChild(infoEl);

    toolEl = document.createElement("div");
    toolEl.style.cssText = "position:fixed;transform:translate(-50%,-50%);text-align:center;white-space:nowrap;" +
      "color:rgba(225,232,255,.55);pointer-events:none;z-index:11;opacity:0;transition:opacity .6s ease;" +
      "text-shadow:0 0 20px rgba(120,170,255,.30);";
    toolEl._on = false;
    document.body.appendChild(toolEl);

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
      "<b>L lock</b> &nbsp;·&nbsp; S shuffle &nbsp;·&nbsp; P pause &nbsp;·&nbsp; C clock/info &nbsp;·&nbsp; H help<br>" +
      "T focus timer &nbsp;·&nbsp; K stopwatch &nbsp;·&nbsp; R reset</div>" +
      "<div style='opacity:.4;margin-top:14px;font-size:.82em'>burn-in shield active · pixel-orbit + auto-dim</div>";
    document.body.appendChild(helpEl);
    setTimeout(function () { if (helpEl.dataset.shown === "1") { helpEl.dataset.shown = "0"; helpEl.style.opacity = "0"; } }, CONFIG.helpVisibleMs);
  }

  /* ---------- URL overrides (e.g. ?lite for TVs / casting to a 4K screen) ----------
     Open the same page with options, no file editing needed:
       ?lite            native res, lighter — recommended on a 4K TV / when casting
       ?scale=1.25      set the render scale directly (0.5–2)
       ?brightness=0.7  master brightness (0.1–1)
       ?dwell=40        seconds per scene
       ?clock=1         start with the drifting clock on
       ?auto=0          disable the auto-quality guard
     Combine with &, e.g. ...?lite&brightness=0.7 */
  function qnum(v, lo, hi, dflt) { var n = parseFloat(v); return isNaN(n) ? dflt : clamp(n, lo, hi); }
  function applyQueryOverrides() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return; }
    if (q.has("lite")) CONFIG.renderScale = 1.0;
    if (q.has("scale")) CONFIG.renderScale = qnum(q.get("scale"), 0.5, 2, CONFIG.renderScale);
    if (q.has("renderScale")) CONFIG.renderScale = qnum(q.get("renderScale"), 0.5, 2, CONFIG.renderScale);
    if (q.has("brightness")) { CONFIG.brightness = qnum(q.get("brightness"), 0.1, 1, CONFIG.brightness); brightness = CONFIG.brightness; }
    if (q.has("dwell")) CONFIG.dwellSeconds = qnum(q.get("dwell"), 5, 600, CONFIG.dwellSeconds);
    if (q.has("clock")) CONFIG.infoMode = (q.get("clock") !== "0" && q.get("clock") !== "false") ? 1 : 0;
    if (q.has("info")) CONFIG.infoMode = Math.max(0, Math.min(4, parseInt(q.get("info"), 10) || 0));
    if (q.has("auto")) CONFIG.autoQuality = (q.get("auto") !== "0" && q.get("auto") !== "false");
    if (q.has("scene")) CONFIG.startScene = q.get("scene");
    if (q.has("only")) { CONFIG.startScene = q.get("only"); CONFIG.lock = true; }   // pin to one scene
    if (q.has("lock")) CONFIG.lock = (q.get("lock") !== "0" && q.get("lock") !== "false");
  }

  function normName(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function resolveSceneIndex(spec) {
    if (spec == null) return -1;
    var s = String(spec).trim();
    if (/^\d+$/.test(s)) { var n = parseInt(s, 10); if (n >= 0 && n < scenes.length) return n; }
    var t = normName(s);
    var i;
    for (i = 0; i < scenes.length; i++) if (normName(scenes[i].name) === t) return i;     // exact
    for (i = 0; i < scenes.length; i++) if (normName(scenes[i].name).indexOf(t) >= 0) return i; // partial
    return -1;
  }

  /* ---------- boot ---------- */
  function boot() {
    applyQueryOverrides();
    infoMode = CONFIG.infoMode;
    detectColorSpace();
    build();
    scenes = (window.OLED_SCENES || []).filter(function (s) { return s && typeof s.draw === "function"; });
    sizeStage();

    if (!scenes.length) {
      // nothing registered — show a gentle built-in fallback so the screen is never dead
      scenes = [fallbackScene()];
    }
    buildOrder();
    var startIdx = resolveSceneIndex(CONFIG.startScene);
    if (startIdx >= 0) {
      var pos = order.indexOf(startIdx);
      if (pos > 0) { order.splice(pos, 1); order.unshift(startIdx); }
    }
    locked = !!CONFIG.lock;
    gotoScene(order[0], true);

    window.addEventListener("resize", sizeStage);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMouse);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { paused = true; }
      else { paused = false; lastFrame = 0; qualityCooldown = now() + 3; }
    });

    lastMouse = performance.now();
    qualityCooldown = now() + 4;   // warm up before judging frame rate
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
