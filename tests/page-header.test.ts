/**
 * Pins page titles to CSS balancing. `react-wrap-balancer` injected a <script>
 * into `h1`, which leaked into the accessible name (and first paint).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const header = readFileSync(resolve(process.cwd(), 'components/ui/page-header.tsx'), 'utf8');

if (header.includes('react-wrap-balancer')) {
  throw new Error('Balancer injects a <script> into h1');
}
if (!/text-balance/.test(header)) {
  throw new Error('titles should balance with CSS, not a script');
}

process.stdout.write('PASS page titles do not inject wrap-balancer script into headings\n');
