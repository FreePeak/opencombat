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

Phase 5/6 flows (mode picker on the login screen):
  waves  - the default PvE arena (the original smoke above)
  world  - Open World: chunk streaming + minimap + playable character
  pvp    - Lobby queue -> seat reservation redirect -> ArenaRoom match
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

WORLD_PROBE = """
() => {
  const gs = window.__gameScene;
  if (!gs || !gs.room) return null;
  return {
    worldMode: !!gs.worldMode,
    chunks: gs.chunkManager ? gs.chunkManager.loadedCount : 0,
    minimap: !!gs.minimap && !!gs.minimap.canvas && document.body.contains(gs.minimap.canvas),
    room: gs.room.name,
    playing: gs.room.state.matchState === 'playing'
  };
}
"""

PVP_PROBE = """
() => {
  const dbg = window.__OPENGAME_DEBUG__;
  if (!dbg || !dbg.room) return null;
  return { name: dbg.room.name, state: dbg.room.state ? dbg.room.state.matchState : '?' };
}
"""

# ARTWORK_PLAN phase 2: fog matched to the sky color, present in every mode.
SCENE_PROBE = """
() => {
  const gs = window.__gameScene;
  if (!gs || !gs.scene) return null;
  const fog = gs.scene.fog;
  const bg = gs.scene.background;
  return {
    fog: !!fog,
    fogNear: fog ? fog.near : null,
    fogFar: fog ? fog.far : null,
    fogColor: fog ? '#' + fog.color.getHexString() : null,
    bg: bg && bg.getHexString ? '#' + bg.getHexString() : null
  };
}
"""


# ARTWORK_PLAN phase 1: instanced grass ground cover in both visual contexts.
DRESSING_PROBE = """
(mode) => {
  const gs = window.__gameScene;
  if (!gs) return null;
  if (mode === 'world') {
    if (!gs.chunkManager) return { world: 'no chunkManager' };
    let chunks = 0, grassy = 0, tufts = 0;
    for (const [, entry] of gs.chunkManager.loaded) {
      chunks++;
      const g = entry.group.children.find((o) => o.isInstancedMesh && o.name === 'grass');
      if (g) { grassy++; tufts += g.count; }
    }
    return { world: true, chunks, grassy, tufts };
  }
  let grass = null, flowers = null;
  gs.scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    if (o.name === 'grass') grass = { count: o.count, castShadow: o.castShadow };
    if (o.name === 'flowers') flowers = { count: o.count, castShadow: o.castShadow };
  });
  return { arena: true, grass, flowers };
}
"""


def assert_dressing(page, label, mode):
    probe = page.evaluate(DRESSING_PROBE, mode)
    if mode == "world":
        assert probe.get("world") is True, f"[{label}] world dressing probe: {probe}"
        assert probe["chunks"] > 0 and probe["grassy"] == probe["chunks"], \
            f"[{label}] every streamed chunk must carry grass: {probe}"
        assert probe["tufts"] > 0, f"[{label}] no grass tufts rendered: {probe}"
    else:
        assert probe.get("arena") is True, f"[{label}] arena dressing probe: {probe}"
        assert probe["grass"] and probe["grass"]["count"] >= 250, \
            f"[{label}] arena grass must be 250+ instances: {probe}"
        assert probe["grass"]["castShadow"] is False, \
            f"[{label}] grass must never cast shadows: {probe}"
        assert probe["flowers"] and probe["flowers"]["count"] >= 30, \
            f"[{label}] arena flowers must be 30+ instances: {probe}"
    print(f"[{label}] dressing: {probe}")
    return probe


def assert_atmosphere(page, label):
    probe = page.evaluate(SCENE_PROBE)
    assert probe and probe["fog"], f"[{label}] no scene fog: {probe}"
    assert probe["fogNear"] < probe["fogFar"], f"[{label}] fog near >= far: {probe}"
    assert probe["fogColor"] == probe["bg"], f"[{label}] fog color must match sky: {probe}"
    print(f"[{label}] atmosphere: {probe}")


def watch(page):
    """Collect page errors + console errors/warnings for red/green verdicts."""
    errors, console = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: console.append(f"{m.type}: {m.text}")
            if m.type in ("error", "warning") else None)
    return errors, console


def login(page, name, mode=None):
    """Fill the login form, optionally pick a mode card, click JOIN."""
    page.wait_for_selector("#login.visible", timeout=30000)
    page.fill("#login-name", name)
    if mode is not None:
        page.click(f"#mode-picker button[data-mode='{mode}']")
    page.click("#login-btn")


def wait_until(cond, timeout_s=30, label="condition", poll=0.5):
    deadline = time.time() + timeout_s
    value = None
    while time.time() < deadline:
        value = cond()
        if value:
            return value
        time.sleep(poll)
    raise AssertionError(f"timeout waiting for {label} (last={value})")


def hold_w_and_measure(page, seconds=1.5):
    tags_before = page.eval_on_selector_all(
        ".nametag", "els => els.map(e => e.style.transform)")
    page.keyboard.down("w")
    time.sleep(seconds)
    page.keyboard.up("w")
    tags_after = page.eval_on_selector_all(
        ".nametag", "els => els.map(e => e.style.transform)")
    return tags_before != tags_after, tags_before, tags_after


def flow_waves(browser):
    """Original smoke: default waves mode joins the 'game' room and plays."""
    errors, console = [], []
    page = browser.new_page()
    e, c = watch(page)
    errors += e; console += c
    page.goto(URL, wait_until="domcontentloaded", timeout=30000)
    login(page, "ReproBot")

    deadline = time.time() + 20
    hud, bones = "", None
    while time.time() < deadline:
        hud = page.eval_on_selector("#hud-text", "el => el.textContent")
        bones = page.evaluate(BONES)
        if bones and bones.get("playing"):
            break
        time.sleep(0.5)
    print(f"[waves] hud-text: {hud!r}")
    print(f"[waves] bones inside clone: {bones}")

    moved = None
    if "score" in hud:
        moved, before, after = hold_w_and_measure(page)
        print(f"[waves] moved={moved}")
    assert_atmosphere(page, "waves")
    assert_dressing(page, "waves", "arena")

    page.close()
    bones_ok = bool(bones) and bones["total"] > 0 and bones["inClone"] == bones["total"]
    ok = ("score" in hud) and moved and not errors and bones_ok
    print(f"[waves] page errors: {errors}")
    print(f"[waves] console errors: {console[:10]}")
    return ok, errors, console


def flow_world(browser):
    """Open World: mode card -> world room -> chunks + minimap + movement."""
    errors, console = [], []
    page = browser.new_page()
    e, c = watch(page)
    errors += e; console += c
    page.goto(URL, wait_until="domcontentloaded", timeout=30000)
    login(page, "WorldBot", mode="world")

    probe = wait_until(lambda: page.evaluate(WORLD_PROBE), 30, "world room joined")
    print(f"[world] probe: {probe}")
    assert probe["worldMode"], "worldMode flag not set"
    assert probe["room"] == "world", f"wrong room: {probe['room']}"
    assert probe["chunks"] >= 9, f"too few chunks streamed: {probe['chunks']}"
    assert probe["minimap"], "minimap canvas not in DOM"
    assert probe["playing"], f"matchState: {probe['playing']}"

    moved, before, after = hold_w_and_measure(page)
    print(f"[world] moved={moved}")
    assert_atmosphere(page, "world")
    assert_dressing(page, "world", "world")

    page.close()
    ok = moved and not errors
    print(f"[world] page errors: {errors}")
    print(f"[world] console errors: {console[:10]}")
    return ok, errors, console


def flow_pvp(browser):
    """PvP Arena: two clients queue via the lobby, both get redirected to
    the same arena room and reach an active match."""
    pages = [browser.new_page() for _ in range(2)]
    errs, cons = [], []
    for page in pages:
        e, c = watch(page)
        errs += e; cons += c
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)

    login(pages[0], "PvPBotA", mode="pvp")
    # First queuer waits in the lobby until the second arrives.
    login(pages[1], "PvPBotB", mode="pvp")

    probes = []
    for i, page in enumerate(pages):
        probe = wait_until(
            lambda p=page: (lambda v: v if v and v["name"] == "arena" else None)(p.evaluate(PVP_PROBE)),
            45, f"pvp player {i} redirected to arena")
        probes.append(probe)
        print(f"[pvp] player {i}: {probe}")

    room_ids = []
    for i, page in enumerate(pages):
        rid = wait_until(
            lambda p=page: p.evaluate("() => window.__OPENGAME_DEBUG__.room.roomId"),
            30, f"pvp player {i} roomId")
        room_ids.append(rid)
    print(f"[pvp] roomIds: {room_ids}")
    assert room_ids[0] == room_ids[1], "both players must land in the SAME arena room"

    for i, page in enumerate(pages):
        wait_until(
            lambda p=page: p.evaluate(
                "() => ['countdown','playing'].includes(window.__OPENGAME_DEBUG__.room.state.matchState)"),
            30, f"pvp player {i} match started")
        print(f"[pvp] player {i} match started")

    for page in pages:
        page.close()
    ok = not errs
    print(f"[pvp] page errors: {errs}")
    print(f"[pvp] console errors: {cons[:10]}")
    return ok, errs, cons


def main():
    flows = sys.argv[1:] or ["waves", "world", "pvp"]
    all_errors, all_console, results = [], [], {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        runners = {"waves": flow_waves, "world": flow_world, "pvp": flow_pvp}
        for name in flows:
            ok, errors, console = runners[name](browser)
            results[name] = ok
            all_errors += errors
            all_console += console
        browser.close()

    for name, ok in results.items():
        print(f"RESULT {name}:", "GREEN" if ok else "RED")
    overall = all(results.values()) and not all_errors
    print("RESULT:", "GREEN — all flows pass" if overall else "RED — at least one flow failed")
    sys.exit(0 if overall else 1)


if __name__ == "__main__":
    main()
