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
t=next(x for x in tools if x['name']=='capture_browser_scenario')
sch=t['inputSchema']
acts=sch['properties']['actions']['items']['oneOf']
for v in acts:
    props=v.get('properties',{})
    a=props.get('action',{})
    const=a.get('const') or '(goto-level?)'
    print('== action const:',const)
    for k,spec in props.items():
        if k=='action': continue
        d=spec.get('const'); tp=spec.get('type'); req=k in v.get('required',[])
        extra=''
        if spec.get('oneOf'):
            inner=spec['oneOf']
            extra='| oneOf:' + json.dumps([{kk:vv.get('const',vv.get('type')) for kk,vv in o.get('properties',{}).items()} for o in inner],ensure_ascii=False)[:400]
        print(f'  {k}{"*" if req else ""}: type={tp} const={d}{extra}')
p.terminate()