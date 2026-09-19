#!/usr/bin/env python3
"""Render the capability probe JSON as a readable matrix."""
import json, sys, collections

d = json.load(open(sys.argv[1]))
if d.get("error"):
    print("REFUSED:", d["error"]); sys.exit(2)
if d.get("fatal"):
    print("FATAL:", d["fatal"])

print(f"After Effects {d.get('aeVersion')}   expression engine: {d.get('expressionEngine')}\n")

mark = {"PASS": "PASS  ", "FAIL": "FAIL  ", "REVIEW": "REVIEW"}
by_area = collections.OrderedDict()
for r in d["results"]:
    by_area.setdefault(r["area"], []).append(r)

for area, rows in by_area.items():
    print(f"--- {area} " + "-" * (66 - len(area)))
    for r in rows:
        print(f"  {mark.get(r['verdict'], r['verdict'])}  {r['id']:<4} {str(r.get('evidence',''))[:88]}")
        if r.get("notes"):
            print(f"                {r['notes'][:88]}")
    print()

t = d["tally"]
print(f"{t.get('PASS',0)} pass   {t.get('FAIL',0)} fail   {t.get('REVIEW',0)} review   ({d['total']} probes)")
