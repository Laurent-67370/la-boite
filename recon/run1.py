#!/usr/bin/env python3
# Recon REA trello — 3 scénarios (landing, template KS, dev board) → evidence + PNG extraits
import json, subprocess, base64, os, time
OUT='/root/trello-clone/recon'
os.makedirs(OUT, exist_ok=True)
CHROME='/root/.hermes/tools/chromium-1208/chrome-linux64/chrome'

p = subprocess.Popen(['/usr/bin/rea','--mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
def send(id_, method, params=None):
    msg = {"jsonrpc":"2.0","id":id_,"method":method}
    if params is not None: msg["params"]=params
    p.stdin.write((json.dumps(msg)+'\n').encode()); p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line: return None
        try: d = json.loads(line)
        except Exception: continue
        if d.get('id')==id_: return d.get('result')
init = send(1,'initialize',{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"recon","version":"1"}})
print('init:', init['serverInfo']['name'], init['serverInfo']['version'])

def scenario(i, label, url):
    r = send(10+i,'tools/call',{"name":"capture_browser_scenario","arguments":{
      "browser": {"mode":"launch","executable_path":CHROME,"headless":True},
      "start_url": {"url":url},
      "actions": [{"step_id":"goto0","action":"goto","destination":{"url":url},"wait_until":"load","timeout_ms":60000}],
      "capture": {"at_end":["screenshot","dom","accessibility","url","history"]}
    }})
    if r is None: print(label,'NO RESULT'); return
    s = json.dumps(r, ensure_ascii=False)
    fp = f'{OUT}/{label}.json'
    open(fp,'w').write(s)
    print(f'{label}: {len(s)} bytes → {fp}')
    # extraction inline artifacts (screenshot base64)
    txt=None
    try:
        txt = r['content'][0]['text']
    except Exception: return
    try:
        ev = json.loads(txt)
    except Exception:
        print(label, 'text non-JSON:', txt[:200]); return
    open(f'{OUT}/{label}.evidence.json','w').write(json.dumps(ev,ensure_ascii=False,indent=1))
    # chercher artefacts base64 dans l'arbre
    def walk(o):
        if isinstance(o,dict):
            if o.get('media_type','').startswith('image/png') and isinstance(o.get('data'),str):
                yield o['data']
            for v in o.values(): yield from walk(v)
        elif isinstance(o,list):
            for v in o: yield from walk(v)
    n=0
    for b64 in walk(ev):
        n+=1
        fp=f'{OUT}/{label}-{n}.png'
        open(fp,'wb').write(base64.b64decode(b64) if ',' not in b64[:100] else base64.b64decode(b64.split(',',1)[1]))
        print('  PNG:', fp, os.path.getsize(fp))
    if n==0: print('  (aucun PNG inline)')
    aid = ev.get('evidence_id','?')
    print('  evidence:', aid[:44])

scenario(1,'landing','https://trello.com/')
scenario(2,'board-template','https://trello.com/b/WHOzj88m')
scenario(3,'board-devel','https://trello.com/b/nC8QJJoZ')
p.terminate()