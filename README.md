# OLED Ambient Show

A self-contained, **burn-in-safe generative ambient display** for an always-on OLED screen.
Fifteen never-repeating scenes — cosmic nebulae, flow fields, spiral galaxies,
pinpoint starfields, hairline filaments and filigree — that crossfade forever on true black.
No installs, no accounts, no files to download. Just open it and press **F11**.

### ▶ Live: https://ericdataplus.github.io/oled-ambient-show/

Built for a 13" 1080p OLED (~170 PPI), so it renders at native resolution **with
supersampling** for razor-sharp fine detail — but it scales to any screen.

---

## Why it's safe to leave on

Static, bright, unchanging pixels are what burns an OLED. This show is engineered against that:

- **Pixel-orbit** — the entire image slowly drifts in a ~14px Lissajous loop that never
  visibly repeats, with overscan so you never see an edge. No pixel is ever pinned.
- **Everything moves** — every scene is full-motion; reviewers specifically hardened each one
  so bright cores/anchors slowly drift and never sit on the same pixels.
- **True black** — backgrounds are `#000000`, so most pixels are simply *off* (also saves power).
- **Auto-dimming** — master software brightness plus gentle extra dimming late at night.
- **No static UI** — cursor auto-hides, the help card self-dismisses, the optional clock drifts.
- **Fail-to-black** — if any scene ever errors, it paints black instead of freezing a frame.

This complements — it does not replace — your **monitor's own** protections. See
[OLED setup](#recommended-oled-setup) below.

---

## Controls

| Key | Action |
|-----|--------|
| `F11` | Browser fullscreen |
| `Space` / `→` | Next scene |
| `←` | Previous scene |
| `↑` / `↓` | Brightness up / down |
| `S` | Reshuffle the order |
| `P` | Pause / play |
| `C` | Toggle a (drifting, dim) clock |
| `H` / `?` | Show/hide help |

Scenes auto-advance every ~35–75s (randomized so it never feels metronomic) with a 4s crossfade.

---

## Run it

**Easiest:** just open the [live link](https://ericdataplus.github.io/oled-ambient-show/),
drag the window to your OLED, press **F11**.

**Local / offline:** clone the repo and open `index.html` in any modern browser. Everything
is vanilla HTML + Canvas2D — no build step, no dependencies.

```bash
git clone https://github.com/Ericdataplus/oled-ambient-show.git
```

---

## Cast it to a TV (e.g. an LG OLED + Apple TV)

Heads up: an **Apple TV can't "cast" a website** — tvOS has no web browser and no Chromecast.
Two things that *do* work:

- **Easiest — the TV's own browser.** Most smart TVs (LG webOS, Samsung Tizen…) have a built-in
  **Web Browser** app. Open the URL there and go fullscreen — no other device needed, and it can
  stay on. On a 4K TV add **`?lite`** so it runs smoothly:
  `https://ericdataplus.github.io/oled-ambient-show/?lite`
- **AirPlay / screen-mirror** from an iPhone, iPad, or Mac to the Apple TV (Control Center →
  Screen Mirroring). The site runs on your device and mirrors to the TV — fine for a while, but
  the device must stay awake, so it's not ideal for always-on.

Either way the engine **auto-lowers its quality** if it lands on a screen it can't render
smoothly, so it should stay fluid even if you forget `?lite`.

---

## Keep it on permanently

Use the included launcher to open the show in a clean, borderless fullscreen window on your
second monitor.

1. Open **`start-show.cmd`** in a text editor and set two things at the top:
   - `URL` — leave as the live site, or point at your local `index.html`.
   - `POSX` / `POSY` — the top-left pixel of your OLED. If the OLED sits to the **right** of a
     2560-wide main monitor, use `2560,0`; to the **left**, use a negative X. (Find exact
     numbers in *Settings → System → Display*.)
2. Double-click `start-show.cmd`. It launches Chrome (or Edge) fullscreen on that monitor.

**Start automatically at boot:**
- Press `Win+R`, type `shell:startup`, Enter.
- Right-click `start-show.cmd` → **Copy**, then **Paste shortcut** into that Startup folder.

**Keep the screen awake:** *Settings → System → Power* → set **Screen** turn-off to *Never*
(the motion + dimming above are what keep it burn-in-safe while it's on).

> Prefer a fully locked kiosk? In `start-show.cmd`, swap `--start-fullscreen` for `--kiosk`.

---

## Recommended OLED setup

Software can only do so much — your panel's own features do the heavy lifting for an always-on
fullscreen image. Based on current guidance from XDA, PCWorld, and panel makers:

- **Turn on the monitor's Pixel Shift / Screen Move / Orbit** in its on-screen menu, and never
  skip its periodic *pixel refresh* (~every 4h) and *pixel cleaning* (~every few hundred hours)
  prompts. These are display-side and protect fullscreen content the OS can't.
- **Run modest brightness** — roughly **120–150 nits** is plenty and far gentler on the panel.
- **Keep HDR off** for this (it pushes brightness/saturation). Toggle with `Win+Alt+B`.
- **Auto-hide the Windows taskbar** (*Settings → Personalize → Taskbar → Taskbar behaviors*) —
  a permanent taskbar is one of the most common burn-in sources.

---

## Customize

Everything tweakable lives in the `CONFIG` block at the top of [`engine.js`](engine.js):

| Setting | Default | What it does |
|---------|---------|--------------|
| `renderScale` | `1.5` | Supersampling. `1.0` = native/fast, `2.0` = ultra-crisp/heavier. |
| `brightness` | `0.85` | Master software brightness (0–1). Set your **monitor** brightness low too. |
| `dwellSeconds` / `dwellJitter` | `55` / `20` | Base time per scene ± random jitter. |
| `crossfadeSeconds` | `4` | Dissolve length between scenes. |
| `nightDimming` | `true` | Gentle extra dimming in the small hours. |
| `orbitAmplitude` | `14` | How far the burn-in pixel-orbit drifts (px). |
| `showClock` | `false` | Start with the drifting clock on. |

Don't want to edit files? Pass options in the URL instead — **`?lite`**, `?scale=`,
`?brightness=`, `?dwell=`, `?clock=1`, `?auto=0` (documented at the bottom of `engine.js`).

---

## Add your own scene

Drop a file in `scenes/`, add one `<script>` line in `index.html`, done. Each scene is a tiny
self-contained module:

```js
(function () {
  "use strict";
  window.OLED_SCENES = window.OLED_SCENES || [];
  window.OLED_SCENES.push({
    name: "My Scene",
    setup: function (ctx, w, h) { return { /* state */ }; },     // on start + resize
    draw: function (ctx, w, h, t, dt, state) {                   // every frame
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);         // always paint black
      // ... draw using t (seconds) / dt. ctx.oledDPR = real device pixels per CSS px
      //     for true 1-pixel hairlines: ctx.lineWidth = 1 / ctx.oledDPR
    }
  });
})();
```

Keep it mostly black, always moving, no static bright regions, and reset any
`globalCompositeOperation` / `globalAlpha` you change — that's all the engine asks.

---

## License

MIT © neural. Do whatever you like with it.
