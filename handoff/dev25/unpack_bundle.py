from pathlib import Path
import re, sys
src=Path(sys.argv[1] if len(sys.argv)>1 else "DEV25_COORDINATION_CORE_SOURCE.txt")
out=Path(sys.argv[2] if len(sys.argv)>2 else "coordination-core-candidate")
text=src.read_text(encoding="utf-8")
pat=re.compile(r"^===== FILE: (.+?) =====\n(.*?)^===== END FILE: \\1 =====$",re.M|re.S)
items=pat.findall(text)
if not items: raise SystemExit("no files found")
for rel,body in items:
 p=out/rel; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(body,encoding="utf-8",newline="\n")
print(f"wrote {len(items)} files to {out}")
