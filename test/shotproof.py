#!/usr/bin/env python3
"""Headless screenshot + numeric proof for the movement/attack fixes.
Joins the real client as the Knight (the buggy root-motion model), waits for
PLAYING, then captures:
  idle1.png / idle2.png  - Knight idle ~1s apart (RC1: hips must NOT slide)
  attack.png             - mid-swing (RC2: full arc in the 350ms window)
  run.png                - mid-run (movement works + smooth render)
Plus console/JS proof of RC1 (hips world delta over idle) and RC2
(attack action.timeScale). Run with the server serving localhost:2567.

    python3 test/shotproof.py            # screenshots land in test/shots/
"""
import json
import os
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:2567/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)

PROOF = """
() => {
  const gs = window.__gameScene;
  if (!gs || !gs.local || !gs.room) return null;
  const m = gs.local.mesh;
  const hips = [...m.skeleton.bones].find(b => String(b.name).includes('Hips'));
  const root = gs.local.root;
  const h = new THREE.Vector3();
  hips.getWorldPosition(h);
  const p = gs.local.clips.attack;
  return {
    matchState: gs.room.state.matchState,
    root: { x: root.position.x, z: root.position.z },
    hipsWorld: { x: h.x, y: h.y, z: h.z },
    attackClip: p ? {
      duration: p.getClip().duration,
      timeScale: p.timeScale,
      paused: p.paused,
      animName: gs.local.animName,
    } : null,
    hasClips: !!gs.local.mixer,
  };
}
"""

def main():
    errors, console = [], []
    idle1 = idle2 = None
    attack = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}")
                if m.type in ("error", "warning") else None)
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)

        # Select the KNIGHT (index 0 = the root-motion bugged model).
        page.wait_for_selector("#login.visible", timeout=30000)
        page.click(".char-card:has-text('Knight')")
        page.fill("#login-name", "ShotProof")
        page.click("#login-btn")
        print("[shot] clicked JOIN (Knight)", flush=True)

        # Wait until PLAYING.
        deadline = time.time() + 25
        state = None
        while time.time() < deadline:
            state = page.evaluate(PROOF)
            if state and state.get("matchState") == "playing":
                break
            time.sleep(0.5)
        print(f"[shot] state={state and state.get('matchState')}", flush=True)

        # RC1: idle hips must not slide over ~1s (root motion stripped).
        time.sleep(1.0)
        page.screenshot(path=os.path.join(OUT, "idle1.png"))
        idle1 = page.evaluate(PROOF)
        time.sleep(0.9)
        page.screenshot(path=os.path.join(OUT, "idle2.png"))
        idle2 = page.evaluate(PROOF)

        # RC2: trigger an attack swing and screenshot mid-arc.
        page.keyboard.press("j")
        attack = page.evaluate(PROOF)  # read the action while anim='attack'
        page.screenshot(path=os.path.join(OUT, "attack.png"))
        time.sleep(0.6)

        # Run forwards and screenshot mid-stride.
        page.keyboard.down("w")
        time.sleep(0.9)
        page.screenshot(path=os.path.join(OUT, "run.png"))
        page.keyboard.up("w")
        time.sleep(0.3)

        browser.close()

    def fam(v, n=4):
        return f"({v.get('x', 0):.{n}f}, {v.get('y', 0):.{n}f}, {v.get('z', 0):.{n}f})" if isinstance(v, dict) else v

    hips1, hips2 = idle1["hipsWorld"], idle2["hipsWorld"]
    slide = max(abs(hips2["x"] - hips1["x"]), abs(hips2["z"] - hips1["z"]))
    print(f"[proof] idle hips  t1 {fam(hips1)}")
    print(f"[proof] idle hips  t2 {fam(hips2)}")
    print(f"[proof] RC1  hips lateral slide over ~1s idle = {slide:.4f}  (was ~tens of units before fix)")
    if attack and attack["attackClip"]:
        print(f"[proof] RC2  attack clip duration={attackClip_dur(attack['attackClip'])}s "
              f"timeScale={attack['attackClip']['timeScale']:.3f} "
              f"(clip shortened to {attack['attackClip']['duration']/max(attack['attackClip']['timeScale'],1e-9):.3f}s of wall time)")
    print(f"[proof] page errors: {errors}")
    print(f"[proof] console errors: {console[:6]}")
    r1, r2 = idle1["root"], idle2["root"]
    print(f"[proof] idle root delta = ({(r2['x']-r1['x']):.4f}, {(r2['z']-r1['z']):.4f})")
    ok = (slide < 0.05 and not errors)
    print("RESULT:", "GREEN — knight idle is stable; see test/shots/*.png"
          if ok else "RED — still sliding or page error")
    sys.exit(0 if ok else 1)


def attackClip_dur(c):
    return c["duration"]


if __name__ == "__main__":
    main()
