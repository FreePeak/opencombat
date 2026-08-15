#!/usr/bin/env python3
"""E2E regression tests: 'game started but cannot play' and
'character not displayed and not moving'.

Requires the server running (npm run serve) and Python Playwright
(pip install playwright && playwright install chromium). Run:

    python3 test/browser.test.py

Drives the real browser client against the real server:
  join -> countdown -> GO -> hold W -> player must actually move.
Red = page error OR hud stuck on 'connecting...' OR nametag never moves
OR the local player's skinned-mesh bones are outside the clone (the
symptom of cloning a skinned GLB with Object3D.clone instead of
SkeletonUtils.clone, which renders the character collapsed/invisible).
Catches browser-only breakage that the headless node tests cannot reach
(e.g. schema v4 API misuse, THREE scene wiring errors).
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:2567/"

BONES = """
() => {
  const gs = window.__gameScene;
  if (!gs || !gs.local) return null;
  const inside = (obj, root) => {
    for (let n = obj; n; n = n.parent) if (n === root) return true;
    return false;
  };
  let inClone = 0, total = 0;
  gs.local.mesh.traverse(o => {
    if (!o.isSkinnedMesh) return;
    for (const b of o.skeleton.bones) {
      total++;
      if (inside(b, gs.local.root)) inClone++;
    }
  });
  return { total, inClone, playing: gs.room.state.matchState === 'playing' };
}
"""

def main():
    errors, console = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}")
                if m.type in ("error", "warning") else None)
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)

        # Login form -> JOIN
        page.wait_for_selector("#login.visible", timeout=30000)
        page.fill("#login-name", "ReproBot")
        page.click("#login-btn")
        print("[repro] clicked JOIN")

        # Countdown is 3s; wait until the match is actually PLAYING —
        # the world is frozen during countdown, so movement measured
        # there would always be zero.
        deadline = time.time() + 20
        hud, bones = "", None
        while time.time() < deadline:
            hud = page.eval_on_selector("#hud-text", "el => el.textContent")
            bones = page.evaluate(BONES)
            if bones and bones.get("playing"):
                break
            time.sleep(0.5)
        print(f"[repro] hud-text: {hud!r}")
        print(f"[repro] bones inside clone: {bones}")

        # Local player movement signal: our nametag follows the player root.
        moved, tag_before, tag_after = None, None, None
        if "score" in hud:
            tags_before = page.eval_on_selector_all(
                ".nametag", "els => els.map(e => e.style.transform)")
            page.keyboard.down("w")
            time.sleep(1.5)
            page.keyboard.up("w")
            tags_after = page.eval_on_selector_all(
                ".nametag", "els => els.map(e => e.style.transform)")
            tag_before, tag_after = tags_before, tags_after
            moved = tag_before != tag_after
            print(f"[repro] nametag before: {tag_before}")
            print(f"[repro] nametag after : {tag_after}")
            print(f"[repro] moved={moved}")

        browser.close()

    print(f"[repro] page errors: {errors}")
    print(f"[repro] console errors: {console[:10]}")
    bones_ok = bool(bones) and bones["total"] > 0 and bones["inClone"] == bones["total"]
    ok = ("score" in hud) and moved and not errors and bones_ok
    print("RESULT:", "GREEN — can play, character visible and moving"
          if ok else "RED — cannot play or character invisible")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
