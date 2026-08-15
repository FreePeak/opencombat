#!/usr/bin/env python3
"""E2E regression test: 'game started but cannot play'.

Requires the server running (npm run serve) and Python Playwright
(pip install playwright && playwright install chromium). Run:

    python3 test/browser.test.py

Drives the real browser client against the real server:
  join -> countdown -> GO -> hold W -> player must actually move.
Red = page error OR hud stuck on 'connecting...' OR nametag never moves.
Catches browser-only breakage that the headless node tests cannot reach
(e.g. schema v4 API misuse, THREE scene wiring errors).
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:2567/"

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

        # Countdown is 3s; give the client time to wire state + reach GO.
        deadline = time.time() + 15
        hud = ""
        while time.time() < deadline:
            hud = page.eval_on_selector("#hud-text", "el => el.textContent")
            if "score" in hud:
                break
            time.sleep(0.5)
        print(f"[repro] hud-text: {hud!r}")

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
    ok = ("score" in hud) and moved and not errors
    print("RESULT:", "GREEN — can play" if ok else "RED — cannot play")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
