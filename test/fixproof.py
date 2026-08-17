#!/usr/bin/env python3
"""Headless proof for the second-round fixes (RC5/RC6/skill), run against the
live client + server (needs `node src/server/index.js` serving :2567).

  RC5  hold D and sample the camera's azimuth around the player: it must stay
       constant (fixed camera) and the player's path must be a straight line.
       Pre-fix the camera orbited and the path curved ("round and round").
  RC6  hold W then swing (J): while the attack anim plays the server ROOTS the
       caster, so the position must be ~frozen even though W is held.
  SKILL press K: anim becomes 'skill' and skillCd is set (the class's cooldown).

Screenshots land in test/shots/. Run:  python3 test/fixproof.py
"""
import math
import os
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:2567/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)

SNAP = """
() => {
  const gs = window.__gameScene;
  if (!gs || !gs.local || !gs.room) return null;
  const root = gs.local.root;
  const cam = gs.camera;
  const st = gs.local.state;      // server-authoritative PlayerState
  return {
    matchState: gs.room.state.matchState,
    px: root.position.x, pz: root.position.z,   // client render (lerped)
    sx: st.x, sz: st.z,                          // SERVER position (authoritative)
    cx: cam.position.x, cz: cam.position.z,
    anim: gs.local.animName,
    serverAnim: st.anim,
    skillCd: st.skillCd,
    attackAnimT: gs.local.attackAnimT,
  };
}
"""


def azimuth(s):
    # Angle of the camera around the player (what orbited pre-fix).
    return math.atan2(s["cx"] - s["px"], s["cz"] - s["pz"])


def angdiff(a, b):
    d = a - b
    while d > math.pi: d -= 2 * math.pi
    while d < -math.pi: d += 2 * math.pi
    return abs(d)


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        try:
            page.wait_for_selector("#login.visible", timeout=30000)
        except Exception:
            print(f"[fix] login never became visible; page errors so far: {errors}", flush=True)
            raise
        page.click(".char-card:has-text('Knight')")
        page.fill("#login-name", "FixProof")
        page.click("#login-btn")

        deadline = time.time() + 25
        state = None
        while time.time() < deadline:
            state = page.evaluate(SNAP)
            if state and state.get("matchState") == "playing":
                break
            time.sleep(0.5)
        print(f"[fix] matchState={state and state.get('matchState')}", flush=True)
        time.sleep(0.8)  # let spawn/knockback settle

        # ---- RC5: strafe D; camera azimuth constant + straight path --------
        page.keyboard.down("d")
        time.sleep(0.7)  # let the camera lerp settle into its trailing slot
        a0 = azimuth(page.evaluate(SNAP))
        path = []
        for _ in range(5):
            time.sleep(0.18)
            s = page.evaluate(SNAP)
            path.append((s["sx"], s["sz"]))  # server path (authoritative)
        a1 = azimuth(page.evaluate(SNAP))
        page.screenshot(path=os.path.join(OUT, "strafe.png"))
        page.keyboard.up("d")
        az_drift = angdiff(a0, a1)
        # straightness: max cross product of consecutive segments
        cross_max = 0.0
        for i in range(2, len(path)):
            (ax, az), (bx, bz), (cx, cz) = path[i - 2], path[i - 1], path[i]
            cross_max = max(cross_max, abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)))
        print(f"[fix] RC5 camera azimuth drift over D-strafe = {az_drift:.4f} rad (pre-fix: grew continuously)")
        print(f"[fix] RC5 path max curvature (cross) = {cross_max:.4f} (straight line ~= 0)")

        # ---- RC6: hold W, swing J -> SERVER position frozen during attack ---
        time.sleep(0.5)
        page.keyboard.down("w")
        time.sleep(0.6)  # build forward motion so a slide would be obvious
        page.keyboard.press("j")
        time.sleep(0.12)  # let the server register the swing and root the caster
        pre = page.evaluate(SNAP)
        time.sleep(0.2)   # still inside the 350ms attack window
        mid = page.evaluate(SNAP)
        page.screenshot(path=os.path.join(OUT, "attack_rooted.png"))
        page.keyboard.up("w")
        root_delta = math.hypot(mid["sx"] - pre["sx"], mid["sz"] - pre["sz"])
        print(f"[fix] RC6 SERVER position moved while attacking+holding W = {root_delta:.4f} units (pre-fix ~1.8)")
        print(f"[fix] RC6 server anim during window = {mid['serverAnim']!r}")

        # ---- SKILL: press K -> anim 'skill' + cooldown set ------------------
        time.sleep(0.4)
        page.keyboard.press("k")
        time.sleep(0.12)
        sk = page.evaluate(SNAP)
        page.screenshot(path=os.path.join(OUT, "skill.png"))
        print(f"[fix] SKILL anim after K = {sk['anim']!r}, skillCd = {sk['skillCd']:.0f} ms")
        time.sleep(0.4)

        browser.close()

    print(f"[fix] page errors: {errors}")
    ok = (az_drift < 0.06 and cross_max < 0.02 and root_delta < 0.3
          and (sk["anim"] == "skill" or sk["serverAnim"] == "skill")
          and sk["skillCd"] > 0 and not errors)
    print("RESULT:", "GREEN — strafe straight/no camera orbit, attack rooted, skill casts"
          if ok else "RED — one of RC5/RC6/skill still failing")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
