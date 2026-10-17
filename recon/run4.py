#!/usr/bin/env python3
# Round 4 : ouvrir la modale d'une carte (Task XYZ) → screenshot + DOM
import json, subprocess, base64, os
OUT='/root/trello-clone/recon'
CHROME='/root/.hermes/tools/chromium-1208/chrome-linux64/chrome'
p=subprocess.Popen(['/usr/bin/rea','--mcp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
def send(i,m,pr=None):
    msg={"jsonrpc":"2.0","id":i,"method":m}
    if pr is not None: msg["params"]=pr
    p.stdin.write((json.dumps(msg)+'\n').encode()); p.stdin.flush()
    while True:
        l=p.stdout.readline()
        if not l: return None
        try: d=json.loads(l)
        except Exception: continue
        if d.get('id')==i: return d.get('result')
send(1,'initialize',{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"recon","version":"1"}})
acts=[
 {"step_id":"goto0","action":"goto","destination":{"url":"https://trello.com/b/WHOzj88m"},"wait_until":"load","timeout_ms":60000},
 {"step_id":"w1","action":"wait_for_timeout","duration_ms":6000},
 {"step_id":"closemodal","action":"click","locator":{"kind":"role","role":"button","name":"Okay, got it"}},
 {"step_id":"w2","action":"wait_for_timeout","duration_ms":2000},
 {"step_id":"opencard","action":"click","locator":{"kind":"css","selector":'[data-testid="card-name"]:nth-1'}},
 {"step_id":"w3","action":"wait_for_timeout","duration_ms":2500},
]
# clic sur la carte "Task XYZ" (css attribut + texte)
for a in acts:
    if a["step_id"] == "opencard":
        a["locator"] = {"kind": "css", "selector": '[data-testid="card-name"]:has-text("Task XYZ")'}
r=send(50,'tools/call',{"name":"capture_browser_scenario","arguments":{
  "browser":{"mode":"launch","executable_path":CHROME,"headless":True},
  "start_url":{"url":"https://trello.com/b/WHOzj88m"},"actions":acts,
  "capture":{"after_each_step":["screenshot"],"at_end":["screenshot","dom"]}}})
s=json.dumps(r,ensure_ascii=False)
open(f'{OUT}/card-modal.raw.json','w').write(s)
try: ev=json.loads(r['content'][0]['text'])
except Exception:
    print('ERR', s[:300]); p.terminate(); raise SystemExit(1)
steps=ev['normalized_result']['steps']
for si,step in enumerate(steps):
    st=step.get('status'); sid=step.get('step_id'); err=str(step.get('error'))[:80]
    print(f"step{si} {sid}:{st} {err}")
    for kind,a in step.get('artifacts',{}).items():
        v=a.get('value') or {}
        if 'data_base64' in v:
            fp=f'{OUT}/cardmodal-s{si}-{kind}.png'; open(fp,'wb').write(base64.b64decode(v['data_base64'])); print('   ',fp,os.path.getsize(fp))
        elif kind=='dom' and 'text' in v:
            fp=f'{OUT}/cardmodal-dom.html'; open(fp,'w').write(v['text'])
p.terminate()