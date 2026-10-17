#!/usr/bin/env python3
import json, subprocess, re, collections
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
send(1,'initialize',{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"r","version":"1"}})
tools=send(2,'tools/list',{}).get('tools',[])
t=next(x for x in tools if x['name']=='capture_browser_scenario')
s=json.dumps(t['inputSchema'])
consts=sorted(set(re.findall(r'"const": "([a-z_0-9]+)"',s)))
print('consts scenario:',consts)
p.terminate()
print()
print('=== testid top (template) ===')
cnt=collections.Counter(re.findall(r'data-test-id="([^"]+)"',open('/root/trello-clone/recon/board-template-dom.html').read()))
for k,c in cnt.most_common(28): print(f'{c:4} {k}')
print('=== listes vues ===')
html=open('/root/trello-clone/recon/board-template-dom.html').read()
txt=re.sub(r'<[^>]+>',' ',html)
for m in ('Backlog','Planning','In Progress','Review','Done','Staging area','Importance','estimate'):
    n=txt.count(m)
    print(f'{n:3} {m}')