// Pre-v0 path-rewrite experiment per ARCHITECTURE.md §14.1 / §7.5.
// Mirrors §7.3 algorithm. Deviation from spec: §7.4 case 3 says normalize to
// forward slashes, but Windows Claude Code stores backslashes (verified: 134
// occurrences of escaped backslash form, 0 of forward-slash form in the source
// session). Keeping native separators.

import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = 'F:\\Unity Projects\\deep-cleaning-services';
const destRoot   = 'F:\\drev-experiment';

const SRC = 'C:/Users/Frostborn/.claude/projects/F--Unity-Projects-deep-cleaning-services/83a0c3cb-6410-441a-a57c-99e44fda268e.jsonl';
const DST = 'C:/Users/Frostborn/.claude/projects/F--drev-experiment/83a0c3cb-6410-441a-a57c-99e44fda268e.jsonl';

function rewritePaths(jsonl, src, dst) {
  if (src === dst) return jsonl;
  const escSrc = JSON.stringify(src).slice(1, -1);
  const escDst = JSON.stringify(dst).slice(1, -1);
  return jsonl.split('\n').map(line => {
    if (!line.trim()) return line;
    return line
      .split(escSrc).join(escDst)   // JSON-escaped first (more specific)
      .split(src).join(dst);        // raw form second
  }).join('\n');
}

const input = fs.readFileSync(SRC, 'utf8');
const output = rewritePaths(input, sourceRoot, destRoot);

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, output);

const escSrc = JSON.stringify(sourceRoot).slice(1, -1);
const escDst = JSON.stringify(destRoot).slice(1, -1);
const srcCount = (input.match(new RegExp(escSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
const dstCount = (output.match(new RegExp(escDst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
const remainingSrc = (output.match(new RegExp(escSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

console.log(`source bytes:       ${input.length}`);
console.log(`output bytes:       ${output.length}`);
console.log(`source escaped form found in input:  ${srcCount}`);
console.log(`dest   escaped form found in output: ${dstCount}`);
console.log(`source escaped form remaining in output: ${remainingSrc}`);
console.log(`wrote: ${DST}`);
