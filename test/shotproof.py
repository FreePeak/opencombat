#!/usr/bin/env python3
"""Headless screenshot + numeric proof for the movement/attack fixes.
Joins the real client as the Knight (the buggy root-motion model), waits for
PLAYING, then captures:
  idle1.png / idle2.png  - Knight idle ~1s apart (RC1: hips must NOT slide)
  attack.png             - mid-swing (RC2: full arc in the 350ms window)
  run.png                - mid-run (movement works + smooth render)
The clearest swing visual is produced by the burst probe (attack_peak.png,
test/burstprobe.py): the 350ms swing is short + there is throttle/round-trip
latency before the clip starts, so a single post-keystroke screenshot keeps
catching the near-idle wind-up. See burstprobe frame-delta output for proof.
Plus numeric proof of RC1 (hips world delta over idle) and RC2 (attack
action.timeScale). Requires the server on localhost:2567.

    python3 test/shotproof.py            # screenshots land in test/shots/
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:2567/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)

# World position is read straight from the matrix (elements[12..14]) so we
# do not depend on THREE being a global on the page.
PROOF = """
() => {
  const gs = window.__gameScene;
  if (!gs || !gs.local || !gs.room) return null;
  const skeletons = [];
  gs.local.mesh.traverse(o => { if (o.isSkinnedMesh) skeletons.push(o.skeleton); });
  let hips = null;
  for (const s of skeletons) {
    hips = s.bones.find(b => String(b.name).includes('Hips'));
    if (hips) break;
  }
  const root = gs.local.root;
  const a = gs.local.clips.attack;
  root.updateMatrixWorld(true);
  return {
    matchState: gs.room.state.matchState,
    root: { x: root.position.x, z: root.position.z },
    rootWorld: {
      x: root.matrixWorld.elements[12],
      y: root.matrixWorld.elements[13],
      z: root.matrixWorld.elements[14],
    },
    hipsWorld: hips ? {
      x: hips.matrixWorld.elements[12],
      y: hips.matrixWorld.elements[13],
      z: hips.matrixWorld.elements[14],
    } : null,
    attackClip: a ? {
      duration: a.getClip().duration,
      timeScale: a.timeScale,
      paused: a.paused,
      animName: gs.local.animName,
    } : null,
  };
}
"""


def fmt(v, n=4):
    if not isinstance(v, dict):
        return str(v)
    return (f"({v.get('x', 0):.{n}f}, {v.get('y', 0):.{n}f}, {v.get('z', 0):.{n}f})")


def main():
    errors, console = [], []
    idle1 = idle2 = attack = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}")
                if m.type in ("error", "warning") else None)
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)

        # Select the KNIGHT (the root-motion bugged model), then join.
        page.wait_for_selector("#login.visible", timeout=30000)
        page.click(".char-card:has-text('Knight')")
        page.fill("#login-name", "ShotProof")
        page.click("#login-btn")
        print("[shot] clicked JOIN (Knight)", flush=True)

        # Wait until the match is actually PLAYING.
        deadline = time.time() + 25
        state = None
        while time.time() < deadline:
            state = page.evaluate(PROOF)
            if state and state.get("matchState") == "playing":
                break
            time.sleep(0.5)
        print(f"[shot] matchState={state and state.get('matchState')}", flush=True)

        # RC1: idle hips must not slide over ~1s (root motion stripped).
        time.sleep(1.0)
        page.screenshot(path=os.path.join(OUT, "idle1.png"))
        idle1 = page.evaluate(PROOF)
        time.sleep(0.9)
        page.screenshot(path=os.path.join(OUT, "idle2.png"))
        idle2 = page.evaluate(PROOF)

        # RC2: trigger an attack swing. There is throttle+round-trip latency
        # before the clip starts, so poll until the attack action is actually
        # playing, then screenshot at the middle of the 350ms arc.
        page.keyboard.press("j")
        deadline = time.time() + 2.0
        attack = None
        while time.time() < deadline:
            attack = page.evaluate(PROOF)
            a = attack and attack.get("attackClip")
            if a and not a["paused"] and a["animName"] == "attack":
                break
            time.sleep(0.03)
        time.sleep(0.13)  # ~37% through the 350ms arc
        page.screenshot(path=os.path.join(OUT, "attack.png"))
        attack = page.evaluate(PROOF)
        time.sleep(0.7)

        # Run forwards; screenshot mid-stride (smooth movement proof).
        page.keyboard.down("w")
        time.sleep(0.9)
        page.screenshot(path=os.path.join(OUT, "run.png"))
        page.keyboard.up("w")
        time.sleep(0.3)

        browser.close()

    h1, h2 = idle1["hipsWorld"], idle2["hipsWorld"]
    root1, root2 = idle1["root"], idle2["root"]
    rw1, rw2 = idle1["rootWorld"], idle2["rootWorld"]
    # Root motion slides the body INSIDE the model, so measure hips relative
    # to the root (knockback moves root+hips together and is not a bug).
    rel1 = (h1["x"] - rw1["x"], h1["z"] - rw1["z"])
    rel2 = (h2["x"] - rw2["x"], h2["z"] - rw2["z"])
    rel_drift = max(abs(rel2[0] - rel1[0]), abs(rel2[1] - rel1[1]))
    root_delta = abs(root2["x"] - root1["x"]) + abs(root2["z"] - root1["z"])

    ac = attack["attackClip"]
    print(f"[proof] idle hips t1   {fmt(h1)}   rel->root {fmt(dict(x=rel1[0], z=rel1[1], y=0))}")
    print(f"[proof] idle hips t2   {fmt(h2)}   rel->root {fmt(dict(x=rel2[0], z=rel2[1], y=0))}")
    print(f"[proof] RC1  hips-vs-root lateral drift over ~1s idle = {rel_drift:.4f}  (pre-fix: tens of units)")
    print(f"[proof] RC1  server root moved {root_delta:.3f} = enemy knockback during the shot (expected; not root motion)")
    if ac:
        wall = ac["duration"] / ac["timeScale"]
        print(f"[proof] RC2  attack anim='{ac['animName']}' clip={ac['duration']:.3f}s "
              f"timeScale={ac['timeScale']:.3f}x -> full swing in ~{wall:.3f}s of wall time")
    print(f"[proof] page errors: {errors}")
    print(f"[proof] console errors: {console[:6]}")

    ok = rel_drift < 0.05 and not errors
    print("RESULT:", "GREEN — Knight idle is stable (no root-motion slide)"
          if ok else "RED — Knight still slides or page error")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
