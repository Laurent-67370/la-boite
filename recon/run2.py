#!/usr/bin/env python3
# Round 2 : boards publics avec attente + extraction PNG/DOM
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

def scenario(i,label,url,prerolls):
    acts=[{"step_id":"goto0","action":"goto","destination":{"url":url},"wait_until":"load","timeout_ms":60000}]+prerolls
    r=send(20+i,'tools/call',{"name":"capture_browser_scenario","arguments":{
      "browser":{"mode":"launch","executable_path":CHROME,"headless":True},
      "start_url":{"url":url},"actions":acts,
      "capture":{"after_each_step":["screenshot"],"at_end":["screenshot","dom","accessibility"]}}})
    s=json.dumps(r,ensure_ascii=False)
    open(f'{OUT}/{label}.r2.json','w').write(s)
    ev=None
    try: ev=json.loads(r['content'][0]['text'])
    except Exception: print(label,'ERR',s[:200]); return
    open(f'{OUT}/{label}.r2.evidence.json','w').write(json.dumps(ev,ensure_ascii=False,indent=1))
    for si,step in enumerate(ev['normalized_result']['steps']):
        st=step.get('status'); sid=step.get('step_id')
        for kind,a in step.get('artifacts',{}).items():
            v=a.get('value') or {}
            if 'data_base64' in v:
                fp=f'{OUT}/{label}-s{si}-{kind}.png'
                open(fp,'wb').write(base64.b64decode(v['data_base64']))
                print(f'  {label} step{si}({sid}:{st}) {kind} → {fp} {os.path.getsize(fp)}')
            elif 'text' in v and len(v['text'])>500 and kind in('dom','accessibility'):
                fp=f'{OUT}/{label}-s{si}-{kind}.html'
                open(fp,'w').write(v['text'])
    print(f'{label}: evidence {ev.get("evidence_id","?")[:40]}')

# template board : goto + 8s d'attente (le contenu charge en guest)
scenario(1,'tpl-w8','https://trello.com/b/WHOzj88m',
         [{"step_id":"w1","action":"wait_for_timeout","duration_ms":8000}])
p.terminate()