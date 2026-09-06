import asyncio, json, os, subprocess, time, urllib.request, websockets

CDP_BASE = 'http://127.0.0.1:9222'

chrome_cmd = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    r'--user-data-dir=C:\Users\Zaid Mohammed\AppData\Local\Temp\cprof_diag',
    'about:blank'
]
try:
    urllib.request.urlopen(f'{CDP_BASE}/json/version', timeout=1)
except Exception:
    subprocess.Popen(chrome_cmd)
    for _ in range(20):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(f'{CDP_BASE}/json/version', timeout=1)
            break
        except Exception:
            pass

req = urllib.request.Request(f"{CDP_BASE}/json/new?http://localhost:8088/blackbox_testbed.html", method="PUT")
tab = json.load(urllib.request.urlopen(req))
ws_url = tab['webSocketDebuggerUrl']
tab_id = tab['id']

async def rpc(ws_url, method, params=None, timeout=20):
    async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            if m.get("id") == 1:
                if "error" in m:
                    raise RuntimeError(json.dumps(m["error"])[:300])
                return m.get("result", {})

async def ev(ws_url, expr, timeout=20):
    r = await rpc(ws_url, "Runtime.evaluate",
                  {"expression": expr, "awaitPromise": True, "returnByValue": True}, timeout)
    if r.get("exceptionDetails"):
        ed = r["exceptionDetails"]
        raise RuntimeError(f"EVAL-EXC: {ed.get('exception', {}).get('description') or json.dumps(ed)[:400]}")
    return r.get("result", {}).get("value")

ext_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "extension"))
scripts = [
    "lib/protocol.js",
    "lib/privacy/pii-regex.js",
    "lib/privacy/dom-detector.js",
    "lib/privacy/fusion.js",
    "lib/privacy/policy.js",
    "lib/redactor.js",
    "lib/dom-perception.js",
    "lib/record-extraction.js",
    "lib/task-parser.js",
    "lib/goal-manager.js",
    "lib/world-state.js",
    "lib/state-sync.js",
    "lib/element-registry.js",
    "lib/multimodal-grounding.js",
    "lib/content-executor.js",
    "lib/post-condition.js",
    "lib/recovery-engine.js",
    "lib/local-secret-handler.js",
    "lib/privacy/see-gate.js",
    "lib/privacy/do-gate.js",
    "lib/privacy/egress-gate.js",
    "lib/browser-controller.js",
    "lib/agent-loop.js",
]

import threading
from test_real_agent_e2e import run_server

server_thread = threading.Thread(target=run_server, daemon=True)
server_thread.start()
time.sleep(0.3)

async def main():
    for s in scripts:
        code = open(os.path.join(ext_dir, s), encoding="utf-8").read()
        await ev(ws_url, code)
    print("Injected scripts.")

    res = await ev(ws_url, """
        (async function() {
            const loop = new PBA.AgentLoop({ maxSteps: 3, serverUrl: 'http://127.0.0.1:8000' });
            const logs = [];
            loop.onLog = (l) => logs.push(l);
            try {
                await loop.startTask('Search Wikipedia for Ada Lovelace.');
            } catch(e) {
                logs.push({ kind: 'caught_exception', error: e.message, stack: e.stack });
            }
            return {
                logs,
                stepCount: loop.goalManager ? loop.goalManager.stepCount : 0,
                status: loop.goalManager ? loop.goalManager.status : 'none'
            };
        })()
    """)
    print("Execution Result:")
    print(json.dumps(res, indent=2))

asyncio.run(main())
