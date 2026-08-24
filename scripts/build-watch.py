#!/usr/bin/env python3
"""A live gauge for a running bake.

The pipeline writes `data/build-progress.json` every 0.1% of the phase that
carries the tiles and on every phase change (see `sydney.progress`). This serves a
one-page dashboard that reads it and paints where the build is -- overall bar,
current phase, rate and two ETAs -- refreshing a couple of times a second. Open
it in a browser (or the Claude Code Browser pane) while a `build` runs:

    python3 scripts/build-watch.py            # http://localhost:8899
    python3 scripts/build-watch.py --port 9001 --file /path/to/build-progress.json

Stdlib only, no dependencies. It reads the file each request, so the page is live
without the pipeline knowing it exists.
"""

import argparse
import http.server
import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_FILE = Path(os.environ.get("SYDNEY_DATA_ROOT", REPO / "data")) / "build-progress.json"

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bake Watch</title>
<style>
  :root{--bg:#0c1112;--card:#131a1b;--ink:#e2e9e6;--ink2:#a0aeab;--ink3:#6e7c79;
    --rule:#263130;--rule2:#1c2425;--go:#5cc5a3;--go-soft:#16302a;--amber:#d0a75f;--red:#e0655a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;padding:clamp(16px,4vw,40px)}
  .wrap{max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
  h1{font-size:20px;font-weight:700;letter-spacing:-.02em;margin:0}
  .sub{color:var(--ink2);font-size:13px;margin:0}
  .card{background:var(--card);border:1px solid var(--rule);border-radius:6px;
    padding:clamp(16px,3vw,24px);display:flex;flex-direction:column;gap:16px}
  .big{font:700 clamp(40px,11vw,72px)/1 "SF Mono",ui-monospace,monospace;letter-spacing:-.04em;color:var(--go)}
  .big.stale{color:var(--amber)} .big.dead{color:var(--red)}
  .phase{font:600 13px/1 sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3)}
  .msg{color:var(--ink2);font-size:14px;min-height:1.4em}
  .bar{height:14px;border:1px solid var(--rule);border-radius:4px;background:var(--rule2);overflow:hidden}
  .fill{height:100%;background:var(--go);width:0;transition:width .4s ease}
  .fill.phase{background:var(--go-soft);border-right:2px solid var(--go)}
  .row{display:flex;justify-content:space-between;font:12px/1 "SF Mono",ui-monospace,monospace;color:var(--ink3)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;
    background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
  .cell{background:var(--card);padding:12px 14px;display:flex;flex-direction:column;gap:3px}
  .cell .k{font:600 10px/1 sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3)}
  .cell .v{font:500 19px/1 "SF Mono",ui-monospace,monospace;letter-spacing:-.02em}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--go);display:inline-block;margin-right:7px;
    animation:pulse 1.6s ease-in-out infinite}
  .dot.stale{background:var(--amber);animation:none} .dot.dead{background:var(--red);animation:none}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
</style></head><body>
<div class="wrap">
  <div><h1>Bake Watch</h1><p class="sub" id="src"></p></div>
  <div class="card">
    <div class="phase"><span class="dot" id="dot"></span><span id="state">connecting</span></div>
    <div class="big" id="pct">--%</div>
    <div class="bar"><div class="fill" id="overall"></div></div>
    <div class="row"><span id="phaseName">phase</span><span id="phasePct"></span></div>
    <div class="bar"><div class="fill phase" id="phasebar"></div></div>
    <div class="msg" id="msg"></div>
    <div class="grid">
      <div class="cell"><span class="k">Done / Total</span><span class="v" id="dt">--</span></div>
      <div class="cell"><span class="k">Rate</span><span class="v" id="rate">--</span></div>
      <div class="cell"><span class="k">Phase ETA</span><span class="v" id="peta">--</span></div>
      <div class="cell"><span class="k">Overall ETA</span><span class="v" id="oeta">--</span></div>
      <div class="cell"><span class="k">Elapsed</span><span class="v" id="elapsed">--</span></div>
      <div class="cell"><span class="k">Phase</span><span class="v" id="pidx">--</span></div>
    </div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
const dur=s=>{if(s==null)return"--";s=Math.max(0,Math.round(s));const h=s/3600|0,m=(s%3600)/60|0,x=s%60;
  return h?`${h}h ${String(m).padStart(2,"0")}m`:m?`${m}m ${String(x).padStart(2,"0")}s`:`${x}s`};
async function poll(){
  let d;try{d=await(await fetch("/progress.json?"+Date.now())).json()}catch(e){setState("no build","dead");return}
  if(!d||d.error){setState("no build running","dead");$("msg").textContent=d&&d.error||"";return}
  const age=(Date.now()/1000)-(d.updated_at||0);
  const done=d.done_flag, stale=!done&&age>15;
  setState(done?"finished":stale?`stalled (${dur(age)} quiet)`:"building",done?"":stale?"stale":"go");
  $("pct").textContent=(d.overall_pct??0).toFixed(1)+"%";
  $("pct").className="big"+(done?"":stale?" stale":"");
  $("overall").style.width=(d.overall_pct??0)+"%";
  $("phaseName").textContent=(d.phase||"")+"";
  $("phasePct").textContent=(d.phase_pct??0).toFixed(1)+"%";
  $("phasebar").style.width=(d.phase_pct??0)+"%";
  $("msg").textContent=d.message||"";
  $("dt").textContent=d.total?`${(d.done||0).toLocaleString()} / ${d.total.toLocaleString()}`:"--";
  $("rate").textContent=d.rate_per_s?d.rate_per_s+"/s":"--";
  $("peta").textContent=dur(d.phase_eta_s);
  $("oeta").textContent=done?"done":dur(d.overall_eta_s);
  $("elapsed").textContent=dur(d.elapsed_s);
  $("pidx").textContent=d.phase_index?`${d.phase_index} / ${d.phase_count}`:"--";
}
function setState(t,cls){$("state").textContent=t;$("dot").className="dot"+(cls&&cls!=="go"?" "+cls:"")}
poll();setInterval(poll,500);
</script></body></html>"""


def make_handler(progress_file: Path):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/progress.json"):
                try:
                    self._send(200, progress_file.read_bytes(), "application/json")
                except FileNotFoundError:
                    self._send(200, b'{"error":"no build-progress.json yet"}', "application/json")
                return
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--file", type=Path, default=DEFAULT_FILE)
    args = ap.parse_args()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.file))
    print(f"bake watch on http://localhost:{args.port}  (reading {args.file})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
