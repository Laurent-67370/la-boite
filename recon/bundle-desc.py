#!/usr/bin/env python3
import json, subprocess
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
t=next(x for x in tools if x['name']=='analyze_web_bundle')
print('DESCRIPTION COMPLÈTE:')
print(t.get('description',''))
sch=t['inputSchema']['properties']
for k in ('cdp_endpoint','target_id','allowed_origins','observation_ms'):
    if k in sch:
        print('==',k,'==')
        print(json.dumps(sch[k],ensure_ascii=False)[:900])
        print()
p.terminate()