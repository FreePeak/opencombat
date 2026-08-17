#!/usr/bin/env python3
"""Burst probe: does the Knight's attack animation produce a visually distinct
pose? Captures N frames across the 350ms swing and reports per-frame delta vs a
pre-attack idle baseline. Writes the most-changed frame to attack_peak.png."""
import base64
import os
import shutil
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:2567/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")

BASELINE = """
() => {
  const gs = window.__gameScene;
  if (!gs || !gs.local || !gs.room) return null;
  return { matchState: gs.room.state.matchState, anim: gs.local.animName };
}
"""

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#login.visible", timeout=30000)
        page.click(".char-card:has-text('Knight')")
        page.fill("#login-name", "BurstProbe")
        page.click("#login-btn")
        deadline = time.time() + 25
        while time.time() < deadline:
            st = page.evaluate(BASELINE)
            if st and st.get("matchState") == "playing":
                break
            time.sleep(0.5)

        time.sleep(0.4)
        baseline = os.path.join(OUT, "_atk_baseline.png")
        page.screenshot(path=baseline)

        page.keyboard.press("j")
        frames = []
        for i in range(16):
            pth = os.path.join(OUT, f"_atk_f{i}.png")
            page.screenshot(path=pth)
            frames.append(pth)
            time.sleep(0.028)
        browser.close()

    # Build data-URLs for baseline + each frame, diff in the browser canvas.
    def du(p):
        return "data:image/png;base64," + base64.b64encode(open(p, "rb").read()).decode()
    urls = {"base": du(baseline)}
    for i, f in enumerate(frames):
        urls[f"f{i}"] = du(f)
    js = """
    (u) => {
      const W=200,H=112; const data={};
      const dec=(src,k,next)=>{ const i=new Image(); i.onload=()=>{
        const c=document.createElement('canvas'); c.width=W; c.height=H;
        const x=c.getContext('2d');
        const kk=Math.min(W/i.naturalWidth,H/i.naturalHeight);
        x.drawImage(i,(W-i.naturalWidth*kk)/2,(H-i.naturalHeight*kk)/2,i.naturalWidth*kk,i.naturalHeight*kk);
        data[k]=x.getImageData(0,0,W,H).data; next(); }; i.src=src; };
      const keys=Object.keys(u); let done=0;
      return new Promise(res=>{
        const finish=()=>{ if(++done!==keys.length) return;
          const D=(a,b)=>{ let s=0,n=0;
            for(let p=0;p<data[a].length;p+=4){ s+=Math.abs(data[a][p]-data[b][p])+Math.abs(data[a][p+1]-data[b][p+1])+Math.abs(data[a][p+2]-data[b][p+2]); n+=3; }
            return s/n; };
          const out=[]; for(let i=0;i<16;i++) out.push({i, d:D('base','f'+i)});
          res(out); };
        keys.forEach(k=>dec(u[k],k,finish)); });
    }
    """
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True); pg = b.new_page()
        res = pg.evaluate(js, urls); b.close()

    res.sort(key=lambda r: -r["d"])
    print("frame deltas vs baseline (sorted, max first):")
    for r in res[:5]:
        print(f"  frame {r['i']}  delta={r['d']:.2f}")
    best = res[0]
    shutil.copy(os.path.join(OUT, f"_atk_f{best['i']}.png"),
                os.path.join(OUT, "attack_peak.png"))
    print(f"peak frame={best['i']} (delta {best['d']:.2f}) -> attack_peak.png")

    for f in frames:
        try: os.remove(f)
        except OSError: pass
    try: os.remove(baseline)
    except OSError: pass


if __name__ == "__main__":
    main()
