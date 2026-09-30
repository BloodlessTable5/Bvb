# HOLDER.io

A playable, dark bubble-map survival game with a personal constellation lobby. The game is a local simulation with 24 AI opponents. Cosmetic progress is saved on this browser, separately for guests and selected Phantom addresses. Address connection is optional; the game has no authenticated ranked server or live fee pool. A separate, local payment lab now prepares wallet-approved Robinhood Chain Testnet transactions using fixed example scores.

## Play

Your lobby constellation grows from active practice time and round points. Preview one hour or 25 hours of illustrative growth without changing your saved profile. Choose an alias and one of six opaque bubble colors, then enter the arena. Move your mouse, use WASD or arrow keys, or drag on a touch screen. Pressing movement keys switches to keyboard control and ignores mouse movement until you click the arena. Releasing the keys stops movement. Holding the mouse at any screen edge keeps moving in that direction. Space splits, C consolidates after the 5-second cooldown, E sheds mass for a forward boost, and Escape pauses. Your split bubbles gently flow around each other and stay separate until you press C. Four or more bubbles organize around stable hubs. From eight cells onward, formations always include a two- or three-bubble offshoot. Asymmetric group sizes, local spokes, neighbor connections, and a few brighter satellite-to-satellite bridges give each formation its own shape. Hub bridges maintain gathering forces; secondary satellite bridges add visual connections without pulling groups into a rigid mesh. Each holder gets a stable layout variation that only rebuilds when bubbles split, merge, or disappear. Each cell moves at its own size-based speed, so splitting gives a real movement advantage; turns let the cluster rearrange and idle flow keeps the holder center still. On-screen split and consolidate buttons support touch play. The six-second spawn shield only protects you from being eaten; you can absorb smaller holders immediately.

Practice rounds last six active minutes; death or leaving banks the progress already earned. Arena size resets on each new run while cosmetic XP persists. Score integrates time spent in the top ten using a fixed curve: 100 points/minute at first, 81 at second, 36 at fifth, and 1 at tenth. Equal mass uses a shared midrank; pauses and absent players earn nothing. Adding low-ranked participants does not improve an existing rank’s weight. Cosmetic XP = active seconds / 6 + round points × 0.25. The lobby can grow to 180 bubbles around one dominant central wallet without changing arena strength or its 16-cell limit. Its personal map repeats an irregular hub-and-branch pattern: dense inner neighborhoods lead into smaller clusters, nested subclusters, and tiny outer offshoots. Cross-connections preserve variety while the hierarchy stays rooted at the center. Click a bubble to highlight it and inspect its number, cosmetic dollar value, token count, share, and creation date. Arrow keys and the previous/next buttons also select bubbles. The illustrative 1,000,000-token supply is allocated by circle area and displayed at a fictional $1 per token ($1 million total). These are playful cosmetic values with no market-price lookup, wallet balance, or reward entitlement. New bubbles have a cool tint that settles into the chosen bubble color over 24 hours of wall time. Birth dates are saved once per earned bubble number when progress is banked; the central wallet is dated when its new profile is created. Existing profiles retain their progress, with unrecorded dates shown as unknown. Bubble numbers retain their history even as growth rearranges the visual map. Previews use illustrative relative ages and do not change saved progress.

AI opponents hold their targets and use split attacks to catch smaller holders. They follow the same speed, food-reward, absorption, and supply accounting rules as the player.

Natural dots now carry 4.2–9.8 base mass (average 7), down 65% from 12–28. The target remains 450 dots with the same refill cadence and glowing bead sizes, so split players can still sweep dense fields while growth takes longer. Capturing other holders still transfers their full mass. Smaller bubbles move faster and get more mass from arena dots. Dot yield tapers smoothly from 2× at mass 80 to 1× at mass 1,200; a mass-450 bubble gets about 1.45×. Each dot carries a bonus allowance funded when it spawns, so the size advantage lasts throughout the match and total supply stays exactly 50,000. Unused allowance returns to the arena reserve. The HUD shows the current yield range across your cells. Ejected orbs and absorbed players always transfer their normal mass, preventing an eject/recollect bonus loop.

Nearby outer cells route up to 30% of each new natural-dot reward to their local hub, keeping at least 70% themselves. Feeding is capped at 45% of the group’s post-pickup mass, and remote split cells keep their whole pickup until they return near the hub. This redistributes the already-funded reward without creating mass or draining existing holdings. Ejected orbs, absorbed holders, and active player consolidation bypass hub feeding. Keeping outer cells smaller preserves their speed and higher dot yield longer, but also leaves them easier to eat. Hubs naturally become slower as they grow; they can still be eaten. These are initial tuning values for playtesting.

The arena has a simple deep navy grid with fine and major lines, cross markers, and sector labels anchored to the world. Supply dots have glowing, dimensional cores. Every bubble has the same centered bloom with a smooth falloff outside its crisp rim. Nearby grid lines catch the bubble color and fade back to the normal dark grid with distance. Luminous connections link each holder's own split bubbles, which gather quickly into compact formations with 18–28 world units of minimum surface clearance. A small 8-unit allowance gives local groups room for gentle relative motion, with roughly 34 units of minimum surface clearance between groups where space allows. Softer group envelopes bring hub centers about 18% closer than the previous layout while preserving normal bubble clearance. Split thrust stays visible, and C pulls the cluster together faster after the cooldown. Different holders never share connections, even when they choose the same color. Small color-matched arrows at the screen edges point toward off-screen holders.

Bubbles have flat opaque fills and soft neon rings. They stay round while moving, splitting, and touching walls; only overlaps with a different holder deform their outline. Contact dents settle back to a circle without wobbling. Every bubble has the same ring width and glow strength. The player defaults to ice white; opponents have color-matched rings. Choose a separate highlight preset or a custom color on the join screen. The preview updates immediately and your choice is remembered. Absorbed holders stretch and shrink into the consuming bubble in 0.3 seconds, while its size grows smoothly.

Splits leave brief light streaks behind the launched bubble. Consolidation gathers light inward, completed merges emit a pulse, and the player's death releases a short ring of light and fragments before the results appear. Effects follow your highlight color, freeze when paused, and clear on restart. These effects are cosmetic; mass transfers and collision rules are unchanged. Reduced-motion preferences suppress suction, streaks, and animated action bursts while keeping static lighting.

Absorb dots and smaller holders. A holder's share is the sum of all their bubbles divided by a fixed 50,000-token supply. Absorption transfers mass exactly; splitting and merging preserve it. Larger holders can eat you. The arena is an open space bounded at 3,200 × 2,400 world units, with no interior obstacles.

## Future ranked competition

Local scores are editable practice data and must never authorize real payouts. A future ranked mode needs synchronized server-owned rounds, equal human starting mass, verified game results, a wallet sign-in challenge verified by the server, and an entry policy addressing multiple accounts and coordinated feeding. The proposed fee-epoch distribution is linear in finalized eligible score, using only funds actually received; the launch venue, fee source, asset, percentage, and epoch length are still undecided. Wallet connection grants no starting mass or score multiplier.

The intended launch chain is Robinhood Chain, an EVM network. The existing game’s Phantom address selector uses Solana addresses and does not authenticate a payment identity; the separate payment lab uses an EVM ownership signature. Production fee collection still needs the actual launched token, payout asset, fee-wallet deposit source, verified scoring, and operational controls. Test deposits and synthetic score weights must never be substituted for those production inputs.

## Robinhood Chain payment test

The separate payment lab runs at `http://127.0.0.1:4175/`. It supports native **test ETH** on [Robinhood Chain Testnet](https://docs.robinhood.com/chain/connecting/) (chain ID 46630). It does not read game scores, collect token fees, or pay mainnet funds. Use Node.js 24 or newer:

```sh
npm ci --ignore-scripts
npm run compile:payments
npm test
npm run payment-lab
```

Open the local URL in a desktop browser with an injected EVM wallet extension. The embedded Codex browser may have no wallet extension; use the same URL in your wallet-enabled browser. This version does not include WalletConnect. Keep private keys and recovery phrases in your wallet; the server accepts neither. Connect the account, switch to the test network, and sign the ownership message. The session expires after 30 minutes or a server restart; reconnecting restores that wallet’s persisted intents.

Get test ETH from the [official faucet](https://faucet.testnet.chain.robinhood.com), then approve deployment of your own test vault. Approve a deposit (default 0.001 test ETH; maximum 0.05 per deposit), leaving some ETH in your wallet for network fees. Choose three distinct recipient addresses that differ from the owner and vault. Preview the fixed Alice/Bob/Cara scores of 216/50/486, inspect the exact destinations and amounts, and approve the payout in the wallet. Deployment, funding, and distribution are separate transactions with additional network fees.

The contract allocates 20% of each deposit plus previous rounding carry, floors each weighted share in wei, and retains 80% for the owner. The three recipient transfers happen atomically. It records both funding IDs and batch IDs onchain so neither can pay twice. Unspent deposits can be refunded; the owner can withdraw retained funds. Rounding dust stays reserved for the next batch. These percentages and scores are test settings, not launch decisions.

Each transaction’s wallet, nonce, chain, calldata, value, and recipients are saved in `.payment-lab/ledger.sqlite` before wallet approval. Other pending wallet transactions must finish before preparing an action; the nonce is checked again after quoting so an intervening transaction cannot silently change the quote. The server only reads the RPC: it never signs or broadcasts. It checks the actual transaction, contract code/owner, receipt events, amounts, and canonical block before marking it confirmed after two blocks. Two confirmations are a test setting, **not a claim of finalized settlement**. The local ledger and audit log survive process restarts; do not delete them to retry an uncertain transaction.

If a wallet or browser response is lost, use **Check result** before sending anything else. **Refresh connection** retries the testnet and restores the connected wallet without opening a signing prompt; an expired session enables **Verify ownership** again. Restoring a verified session and **Check vault** both check the unresolved action onchain, so a completed deployment can unlock funding. Saved history remains visible even if loading the balance fails, and the funding step explains why its button is disabled. An untouched saved deployment can be continued with **Resume saved deployment** in step 2.

History supports transaction-hash recovery using the same saved intent. If a deployment's wallet response was uncertain, step 2 offers **Check and retry saved deployment**. This explicit retry first checks the original action, rejects any known hash, and requires both latest and pending wallet nonces to equal its reserved nonce and the expected contract address to have no code. Only then can it open the wallet for the exact same saved deployment transaction. It never creates another deployment intent, changes its nonce, or clears an uncertain marker just because a read found nothing. Other uncertain transaction types remain restricted to reconciliation and hash recovery.

The app never automatically resends an uncertain transaction. A rejected prompt preserves its original intent and nonce for another explicit approval. Replacing or cancelling a transaction in the wallet, or using the reserved nonce elsewhere, may need manual investigation; unresolved intents stay locked rather than silently creating another payment. A payout preview also fixes its recipients, so check addresses before creating it. A mined failed payout is recorded as failed and its unspent deposit can be refunded.

Local EVM tests exercise deployment, exact payouts, carry, replay prevention, reentrancy, atomic failure, refunds, withdrawal limits, wrong-network rejection, restart recovery, receipt validation, wallet signatures, and HTTP authorization. Passing those tests does not mean a public-testnet transfer has occurred. A user-approved public-testnet transaction and its verified receipt are the next integration check. Before production, replace the fixture contract with reviewed token/epoch logic, authoritative game results, finalized deposit indexing, and settlement/reorg handling appropriate to the actual chain.

## Fee distribution dry run

The isolated `FeeDistributionSimulation` exercises the proposed allocation arithmetic. It is not imported by the game and does not collect fees, authenticate wallets, or send transactions. Its confirmed, finalized, ranked, human, and eligible fields are synthetic fixture inputs, not proof of those properties. Real payouts still require authoritative results, verified treasury receipts, durable accounting, and a transaction settlement system.

For each closed interval, the pool is `floor(new received atomic units × distribution basis points / 10000) + previous carry`. Positive eligible scores are aggregated per wallet, then each allocation is `floor(pool × wallet score / total score)`. Rounding leftovers carry forward. If nobody is eligible, the whole pool carries forward. The percentage applies only to new fees. Integer money and score inputs use decimal strings or BigInt; floating-point amounts are rejected. The practice-score fixture quantizes points to millionths once per finalized round, then allocation uses integer arithmetic.

Fee intervals include their start and exclude their end. A round must fit entirely within one interval; a round finishing exactly at the boundary belongs to the closing interval. A new round starting there belongs to the next. Settlement must proceed in order after each interval closes. Identical receipt/round replays are ignored, conflicting IDs and new records for settled intervals are rejected, and repeating a settlement returns a detached copy of its existing result. This replay protection lasts only for the simulation instance; it is not a durable payment ledger.

Run the automated checks and repeatable example from the repository root:

```sh
node --test tests/*.test.mjs
node scripts/fee-distribution-dry-run.mjs
node scripts/fee-distribution-dry-run.mjs --report fee-distribution-report.html
```

The example uses a one-hour interval, 1,000 fake TEST tokens (six decimals), and a 20% allocation rate. These are test settings, not launch decisions. Actual `RoundTracker` output is mapped through an explicit synthetic actor-to-wallet registry: Alice holds fifth for six minutes (216 points), Bob holds first for thirty seconds then falls below tenth (50), and Cara holds second for six minutes (486). Bots, unlinked actors, and cosmetic XP do not receive shares. The optional report also writes a JSON snapshot alongside the HTML.

## Source

- `dist/index.html`: join screen, leaderboard, controls, dialogs.
- `dist/style.css`: responsive dark interface.
- `dist/engine.mjs`: simulation, fluid cluster motion, collisions, supply accounting, split and merge rules.
- `dist/clusters.mjs`: stable hub membership, multi-connection topology, and capped dot-reward sharing.
- `dist/cluster-links.mjs`: edge-to-edge cluster connections and brief inward feeding sparks.
- `dist/balance.mjs`: size-based movement speed, dot-yield taper, and funded food rewards.
- `dist/progression.mjs`: continuous practice scoring, cosmetic growth, isolated local profiles, and idempotent run records.
- `dist/lobby.mjs` and `dist/lobby.css`: interactive personal constellation renderer, bubble inspection, future-growth previews, and responsive home screen.
- `dist/constellation.mjs`: deterministic recursive cosmetic hierarchy, hit testing, and illustrative token allocation.
- `dist/bubble-history.mjs`: cosmetic age tint, elapsed-age labels, and illustrative preview ages.
- `dist/fee-distribution.mjs`: isolated, in-memory fee-allocation simulation with integer accounting and interval settlement.
- `scripts/fee-fixtures.mjs` and `scripts/fee-distribution-dry-run.mjs`: synthetic scorer-to-allocation example and reproducible HTML/JSON report.
- `dist/wallet.mjs`: optional Phantom public-address connection and account lifecycle; no authentication or transactions.
- `dist/game.js`: rendering, input, camera, HUD, minimap, browser agent tools.
- `dist/bubbles.mjs`: contact deformation, flat fills, soft rings, and absorption animation.
- `dist/appearance.mjs`: highlight presets, custom color picker, and live preview.
- `dist/arena-background.mjs`: world-anchored grid, survey marks, and sector labels.
- `dist/neon.mjs`: cached glowing bead textures, colored grid illumination, split trails, consolidation pulses, and death effects.
- `dist/navigation.mjs`: keyboard/mouse controls, continuous edge steering, and off-screen indicators.
- `dist/pathfinding.mjs`: obstacle-aware routing for AI and consolidation.

Serve the `dist` directory over HTTP with a static web server. No build or runtime dependencies are required. Google Fonts are optional; system font fallbacks are included. Alias, colors, cosmetic progression, and recent practice-run summaries are stored locally. Guest and wallet-address profiles stay separate; connecting does not migrate guest progress or synchronize devices. Local storage is not trusted for ranked rewards.
