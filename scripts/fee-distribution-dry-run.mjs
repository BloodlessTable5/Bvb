import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runFeeDryRunScenario } from './fee-fixtures.mjs';

const scenario = runFeeDryRunScenario();
const first = scenario.firstEpoch, second = scenario.secondEpoch;
for (const epoch of [first, second]) {
  const allocated = epoch.allocations.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  assert.equal(allocated, BigInt(epoch.allocatedTotal));
  assert.equal(allocated + BigInt(epoch.carryOut), BigInt(epoch.distributablePool));
  assert.equal(BigInt(epoch.receivedFees) + BigInt(epoch.carryIn), BigInt(epoch.retainedFees) + allocated + BigInt(epoch.carryOut));
}
assert.equal(second.carryIn, first.carryOut);
assert.equal(second.carryOut, first.carryOut);
assert.equal(second.allocatedTotal, '0');

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
function units(raw) {
  const value = BigInt(raw), scale = 1_000_000n;
  const fraction = String(value % scale).padStart(6, '0').replace(/0+$/, '');
  return (value / scale).toLocaleString('en-US') + (fraction ? '.' + fraction : '');
}
const share = raw => {
  const hundredths = BigInt(raw) * 10000n / BigInt(first.totalScoreUnits);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
};
const tableRows = first.allocations.map(entry => `<tr><th scope="row">${escape(entry.wallet)}</th><td>${units(entry.scoreUnits)}</td><td>${share(entry.scoreUnits)}</td><td>${units(entry.amount)} TEST</td></tr>`).join('\n');
const report = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HOLDER · Fee distribution dry run</title>
<style>
:root{color-scheme:dark;font-family:Segoe UI,Arial,sans-serif;color:#e0ecdf;background:#091115}*{box-sizing:border-box}body{margin:0}main{max-width:960px;margin:auto;padding:48px 28px}h1{font-size:clamp(30px,5vw,46px);line-height:1.12;letter-spacing:-1.6px;margin:14px 0}h2{font-size:21px;margin:30px 0 12px}p{line-height:1.6;color:#99b0ac}.eyebrow{font-size:11px;letter-spacing:1.8px;color:#bee97f}.status{display:inline-block;padding:7px 11px;border:1px solid #506a42;color:#c3f774;border-radius:6px;font-size:12px;margin:8px 0}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0}.card{padding:19px;border:1px solid #293f36;border-radius:10px;background:#101d1d}.card span{font-size:11px;color:#96aea1}.card strong{display:block;margin-top:12px;font-size:27px;font-weight:500;color:#d3eaba}.card small{display:block;color:#75948a;margin-top:7px;line-height:1.5}table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;margin:18px 0}td,th{border-bottom:1px solid #283c36;text-align:right;padding:12px 10px}th:first-child{text-align:left}thead th{font-size:11px;color:#88a797;font-weight:500}tbody th{font-weight:500}.table-wrap{overflow-x:auto}.accounting{background:#10231e;border:1px solid #355341;border-radius:10px;padding:18px 22px;line-height:1.9;font-size:13px;font-variant-numeric:tabular-nums}.accounting strong{color:#c5e995;font-weight:500}.note{font-size:12px}.checks{padding-left:20px;color:#adbfaf;font-size:14px;line-height:1.8}.scope{border-top:1px solid #2b3c36;margin-top:28px;padding-top:4px}code{color:#a5c8d7}footer{font-size:11px;color:#668578;border-top:1px solid #273b31;margin-top:30px;padding-top:15px}@media(max-width:600px){main{padding:28px 18px}.cards{grid-template-columns:1fr}.card strong{font-size:23px}td,th{padding:10px 7px;font-size:11px}}
</style></head><body><main>
<div class="eyebrow">HOLDER / TEST RESULTS</div><h1>Fee distribution dry run.</h1>
<p>Time on the scoreboard becomes a share of a funded pool. This run uses fake wallets, fake TEST tokens, and the game’s existing round scorer.</p>
<div class="status">PASS · allocation and carry accounting</div>
<div class="cards"><div class="card"><span>RECEIVED FEES</span><strong>${units(first.receivedFees)} TEST</strong><small>Confirmed synthetic receipt</small></div><div class="card"><span>TEST DISTRIBUTION RATE</span><strong>${first.distributionBps / 100}%</strong><small>Example setting · not a launch decision</small></div><div class="card"><span>AVAILABLE POOL</span><strong>${units(first.distributablePool)} TEST</strong><small>One-hour test interval · six decimal places</small></div></div>
<h2>Consistent play earns a larger share</h2>
<p>Alice spends six minutes in fifth place: <strong>216 points</strong>. Bob spends thirty seconds in first and the rest below tenth: <strong>50 points</strong>. Cara holds second for six minutes: <strong>486 points</strong>.</p>
<div class="table-wrap"><table><thead><tr><th scope="col">SYNTHETIC WALLET</th><th scope="col">POINTS</th><th scope="col">SCORE SHARE</th><th scope="col">ALLOCATION</th></tr></thead><tbody>${tableRows}</tbody></table></div>
<p class="note">Allocations use full integer precision. Displayed percentages are rounded down to two decimal places. One point is represented by 1,000,000 score units; TEST uses 1,000,000 atomic units per token.</p>
<h2>Every unit is accounted for</h2><div class="accounting">${units(first.receivedFees)} received + ${units(first.carryIn)} carried in<br>= ${units(first.retainedFees)} retained + ${units(first.allocatedTotal)} allocated + <strong>${units(first.carryOut)} carried forward</strong> TEST.</div>
<p>The following interval has no new fees or eligible scores. Its ${units(second.carryIn)} TEST carry remains ${units(second.carryOut)} TEST; the distribution percentage is not charged again.</p>
<h2>Rules exercised</h2><ul class="checks"><li>Score comes from rank over active time, with an explicit fixture mapping from actors to wallets.</li><li>Eligible scores combine per wallet. Bots, unlinked participants and cosmetic XP do not enter allocations.</li><li>Integer division rounds allocations down; no funds disappear into floating-point rounding.</li><li>Fees received at an interval’s end belong to the next interval. A round ending exactly at the boundary belongs to the interval it completed.</li><li>Duplicate IDs, early settlement, late records and replayed settlements are checked in the automated suite.</li></ul>
<div class="scope"><h2>What this confirms</h2><p>The allocation model works for synthetic inputs. It is separate from the playable game and makes no wallet or network calls.</p><p>Real distributions still need a selected fee source, verified receipts, authenticated human results, durable accounting, and transaction submission/reconciliation. The simulation’s eligibility flags and in-memory replay protection are test inputs, not those production systems.</p></div>
<footer>Generated ${escape(new Date().toISOString())} · No real tokens collected or transferred.</footer>
</main></body></html>`;

const outputIndex = process.argv.indexOf('--report');
if (outputIndex !== -1) {
  if (!process.argv[outputIndex + 1]) throw new Error('--report requires an HTML output path');
  const path = resolve(process.argv[outputIndex + 1]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, report);
  await writeFile(path.replace(/\.html$/i, '') + '.json', JSON.stringify(scenario, null, 2) + '\n');
  console.log(`Dry run passed. Report: ${path}`);
}
console.log(JSON.stringify({ status: 'passed', mode: 'simulation-only', firstEpoch: first, secondEpoch: second }, null, 2));
