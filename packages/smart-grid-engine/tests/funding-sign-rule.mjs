import { computeFundingCost } from '../src/funding-helper.mjs';
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 1e-9;
  if (ok) { pass++; console.log(`✅ ${name}: PASS (actual=${actual})`); }
  else { fail++; console.log(`❌ ${name}: FAIL (actual=${actual}, expected=${expected})`); }
}
check('Long, rate=+0.0001 (Long pays)', computeFundingCost('LONG', 1000, 0.0001), 0.10);
check('Short, rate=+0.0001 (Short receives)', computeFundingCost('SHORT', 1000, 0.0001), -0.10);
check('Long, rate=-0.0001 (Long receives)', computeFundingCost('LONG', 1000, -0.0001), -0.10);
check('Short, rate=-0.0001 (Short pays)', computeFundingCost('SHORT', 1000, -0.0001), 0.10);
check('Long, rate=0', computeFundingCost('LONG', 1000, 0), 0);
console.log(`\n결과: PASS=${pass}, FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
