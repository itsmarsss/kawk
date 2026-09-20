"""Local similarity check, not a proof of authorship. Never scans env or private data."""
from pathlib import Path
import hashlib,json,re,sys
root=Path(__file__).resolve().parents[2]
psi=root.parent/'psi-feat-multi-user-discord'
def sources(base,dirs):
 out=[]
 for d in dirs:
  for p in (base/d).rglob('*'):
   if p.suffix in ('.ts','.tsx','.js','.mjs','.py') and not set(p.parts)&{'node_modules','.venv','dist','data','__pycache__'}:
    out.append(p)
 return out
def windows(p):
 lines=[re.sub(r'\s+','',s) for s in p.read_text(errors='replace').splitlines() if s.strip()]
 for i in range(max(0,len(lines)-11)):
  text='\n'.join(lines[i:i+12])
  if len(text)>250:yield hashlib.sha256(text.encode()).digest(),i+1
reference=sources(psi,['packages'])
target=sources(root,['agent/src','agent/client','agent/scripts','agent/web','benchmarks/kawk'])
index={}
for p in reference:
 for h,line in windows(p):index.setdefault(h,[]).append((str(p.relative_to(psi)),line))
matches=[]
for p in target:
 for h,line in windows(p):
  if h in index:matches.append({'target':str(p.relative_to(root)),'normalizedLine':line,'reference':index[h]})
report={'scope':'agent source/client/scripts/web and KAWK benchmarks vs PSI packages, code files only','method':'12 consecutive nonblank whitespace-normalized lines, at least 250 characters','targetFiles':len(target),'referenceFiles':len(reference),'matchingWindows':len(matches),'matches':matches[:50],'limitation':'No matches does not establish provenance or exclude shorter or rewritten copying.'}
print(json.dumps(report,indent=2))
if matches:sys.exit(1)
