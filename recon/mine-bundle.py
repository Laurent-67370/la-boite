#!/usr/bin/env python3
import json
ev=json.load(open('/root/trello-clone/recon/web-bundle.out.json'))
print('evidence:', ev['evidence_id'][:44])
nr=ev['normalized_result']
print('clés:', list(nr.keys()))
for k,v in nr.items():
    if isinstance(v,list): print(f'== {k} (len {len(v)})')
    elif isinstance(v,dict): print(f'== {k} dict keys:', list(v.keys())[:20])
    elif isinstance(v,str): print(f'== {k} =', v[:120])
    else: print('==',k,'=',v)
# dump du premier niveau en fichier lisible
open('/root/trello-clone/recon/web-bundle.pretty.json','w').write(json.dumps(nr,ensure_ascii=False,indent=1))