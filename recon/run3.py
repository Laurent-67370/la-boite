#!/usr/bin/env python3
# Round 3 : fermer modale "Okay, got it" → board propre + structure DOM
import json, subprocess, base64, os, re, collections
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
 {"step_id":"w2","action":"wait_for_timeout","duration_ms":2500},
]
r=send(30,'tools/call',{"name":"capture_browser_scenario","arguments":{
  "browser":{"mode":"launch","executable_path":CHROME,"headless":True},
  "start_url":{"url":"https://trello.com/b/WHOzj88m"},"actions":acts,
  "capture":{"after_each_step":["screenshot"],"at_end":["screenshot","dom"]}}})
s=json.dumps(r,ensure_ascii=False)
try: ev=json.loads(r['content'][0]['text'])
except Exception: print('ERR',s[:400]); p.terminate(); raise SystemExit
open(f'{OUT}/tpl-clean.evidence.json','w').write(json.dumps(ev,ensure_ascii=False,indent=1))
for si,step in enumerate(ev['normalized_result']['steps']):
    print(f"step{si} {step.get('step_id')}:{step.get('status')}")
    for kind,a in step.get('artifacts',{}).items():
        v=a.get('value') or {}
        if 'data_base64' in v:
            fp=f'{OUT}/tpl-clean-s{si}-{kind}.png'
            open(fp,'wb').write(base64.b64decode(v['data_base64']))
            print('   ',fp,os.path.getsize(fp))
        elif kind=='dom' and 'text' in v:
            hp=f'{OUT}/tpl-clean-dom.html'
            open(hp,'w').write(v['text']); print('   ',hp,len(v['text']))
p.terminate()