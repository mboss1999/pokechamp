# Champions Team Builder

A team builder for **Pokémon Champions ranked singles** (Showdown format `[Gen 9 Champions] BSS Reg M-C`:
bring 6, pick 3, level 50, 66 stat points with at most 32 per stat, Champions item pool).
Every recommendation comes from simulated battles run with Pokémon Showdown's own battle engine.

```
sim/       offline simulation pipeline (Node, uses all CPU cores)
web/       the team builder UI (static; reads web/data/results.json)
aws/       run the pipeline on one EC2 Spot instance and pull the results down
```

## Getting started

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/mboss1999/pokechamp.git
cd pokechamp
npm install
./start.sh           # opens http://localhost:5173
```

Simulation output folders (`out/`, `out-*/`) are not checked in. The app only needs `web/data/results.json`, which is.

## Use the app

1. **Rankings**: every legal Pokémon, sorted by simulated strength. Tick the ones you own. Click a row for its
   best set, alternative sets, and its best and worst 1v1 matchups.
2. **Build teams**: the 5 best teams you can make from your collection. Each one comes with full sets (item, ability,
   nature, stat points, moves) chosen to respect Item Clause, plus your best answer to each top threat.
   "Copy team" gives Showdown import text.

Your collection is stored in the browser (localStorage). Use **Import / export** to back it up.

### Tune & validate a team

The precomputed sets are each Pokémon's best *in general*, tuned with random teammates. On a team card, **Tune & validate**
re-tunes the sets for that exact team on your Mac (`sim/refine.js`, run through the local API in `web/serve.cjs`):

1. **Baseline:** measure the team in full 6v6 bring-3 battles against strong meta teams. Opponents are sampled by rating
   and respect Item Clause.
2. **Tune each member in turn:** try up to 7 alternatives (its precomputed alternates, plus single changes to a move,
   item, ability or spread) with the other five fixed. All candidates play identical battles, the top two get a
   larger separate sample, and a change is kept only if it wins there by a one-sided 95% margin.
3. **Validate:** compare the original and tuned teams on a fresh set of battles. If the tuned team isn't better there, the
   original sets are kept. The reported numbers always come from this fresh sample.

Quick, Normal and Thorough simulate about 9k, 18k and 45k battles, roughly 1, 1–3 and 5 minutes on an M-series Mac. The result also
shows how often each member is brought and leads, and which meta Pokémon beat the team most often.

## How the numbers are produced

| Stage | What it simulates | Output |
|---|---|---|
| `sets` | For each of the 311 roster entries (each Pokémon, plus each Mega Stone option), about 15–25 candidate sets are generated from archetypes (all-out attacker, setup sweeper, bulky attacker, defensive support, Trick Room). Each candidate plays 3v3 battles with random teammates against random opponent teams, with the same opponents and seeds for every candidate. Successive halving keeps the winners, then hill climbing tries single changes (swap a move, item, nature/spread or ability). Two passes, so sets adapt to the improved field. | Best set plus up to 3 alternatives with different items |
| `matchups` | 1v1 battles between every pair of best sets, played from both sides. Each result is scored by HP margin, not just win/loss: a win scores 0.5 plus half the winner's remaining HP. | N×N matchup matrix |
| `ladder` | Random 6v6 team battles. The AI picks 3 at team preview (bring 6, pick 3). A logistic (Bradley–Terry) model is fitted to the 3 Pokémon each side actually brought. | Elo-style rating, pick rate, win rate |
| `export` | Bundles everything. | `web/data/results.json` |

The team builder scores a team by how well it answers the field, weighting stronger threats more heavily. For each
threat it blends the 1v1 win rates of your three best answers (50/30/20), because you bring three. The rates are shrunk
toward 50% according to how many battles back them. It also adds a small bonus for the members' own ratings. It searches with greedy construction, swap-based local search and several restarts.

### Battle AIs

`sim/battle.js` has two kinds of pilot:

- **heuristic** (`sim/agent.js`, the default): fast, about 350 battles/s on a 10-core Mac. Details below.
- **rollout4** (`sim/lookahead.js`): for each decision, plays its top options against the opponent's likely replies
  on a copy of the battle for one turn plus 4 heuristic turns, then scores the position. It uses "expected" dice so it
  can't peek at real rolls. It beats the heuristic **62.7% ± 3.1** over 600 mirrored games (`node sim/compare.js
  --a rollout4`), but it is roughly 75× slower per battle. Choose it per stage: `--agent` sets the default,
  `--sets-agent`, `--matchups-agent` and `--ladder-agent` override it (on AWS: `AGENT`, `SETS_AGENT`, …).
  Set tuning plays the vast majority of the battles, so the recommended mix is the fast AI there and the rollout AI
  for matchups and the ladder, which are what rank Pokémon (`MATCHUPS_AGENT=rollout4 LADDER_AGENT=rollout4`).
  Using it for everything took about 17 hours per tuning pass on a 64-core server, which is not worth it. Static one-turn lookahead (`lookahead`) was no better than the heuristic (51%), because it can't see the
  payoff of setup moves.

Both sides of a battle decide before either submits, so neither sees the other's choice. Crashed battles are counted
and reported (`WARNING: … battles crashed`) and left out of every result instead of being scored as draws.
A worker is treated as stuck only after `STALL_MS` (default 3 minutes) with no battle progress, not after a
fixed total time, so slow AIs (`rollout4`, `mc8x8`) can run long batches without being killed.

The heuristic agent (`sim/agent.js`) It estimates damage with the engine's own damage
formula, values setup, status, hazards and recovery by simple rules, switches out of losing matchups, and chooses its
3 at team preview by matchup score. It wins about 90% of games against a random player. It is not a human expert,
so
treat the rankings as "strength when played straightforwardly". Strategies that depend on precise play
(Trick Room teams, weather cores, elaborate setup) are probably underrated.

### Analysis engine (hidden information)

In Champions ranked you only see the opponent's six species. The battle AIs above read the whole battle, so they
can't judge a real decision fairly. The analysis engine reasons only from what a player could know:

- `sim/belief.js` reads the public battle log (preview, revealed moves, items, abilities, Mega Evolution) and keeps a
  belief over each opposing Pokémon's set, starting from the simulated meta: entries weighted by rating, then best
  set over alternatives. It builds *determinized* copies of a battle with the opponent's unseen sets, and which of
  its unseen species it brought, re-drawn from that belief.
- `sim/engine.js` rates every option at one decision. It plays each (my option, their option) pair to the end of
  the game in D determinizations × K dice rolls, then solves the simultaneous-move game in which the opponent knows
  its own sets and I don't (`sim/nash.js`). An option's value is its win probability against the opponent's
  equilibrium replies. As agents: `mc2x2`, `mc4x4` and `mc8x8` (`D`x`K`).
- `sim/draft.js` solves team preview: 60 (lead, back two) options per side, cells estimated by full battles
  with the opponent's sets drawn from the belief, and adaptive sampling (screen everything, refine the contested
  corner, then grade every option against the opponent's equilibrium mix).

### Convergence benchmark

`sim/bench.js` checks whether more simulation would still change decisions. A level is good enough when its
decisions lose under ~1 percentage point of win rate when judged by a bigger or stronger level.

```bash
node sim/bench.js make                                   # 40 draft matchups + 300 battle positions (seeded)
node sim/bench.js turn --level h-4x4                     # analyse every position at one level
node sim/bench.js turn --level h-16x16
node sim/bench.js compare --kind turn --a h-4x4 --b h-16x16
```

Levels are listed at the top of `sim/bench.js`. To measure the reference level's own noise, run it again with
`--salt 1`. On AWS: `COMMAND='node sim/bench.js turn --level h-32x32 --dir out' aws/launch.sh`.

## Run the simulations

```bash
npm run sim:quick                          # ~10 min on a laptop, noisy
node sim/pipeline.js --scale 1             # ~1 h on a 10-core laptop
node sim/pipeline.js --stages export       # rebuild results.json from checkpoints in out/
```

`--scale` multiplies every sample size. `--limit N` runs on N roster entries for testing. Checkpoints go to `--out`
(default `out/`).

### On AWS

```bash
aws/setup.sh                 # once: private S3 bucket + an EC2 role limited to that bucket
SCALE=4 aws/launch.sh        # one c7g.16xlarge Spot instance; uploads results to S3 and terminates itself
aws/status.sh                # progress
aws/fetch.sh                 # copy results into web/data/results.json
```

The instance has a hard shutdown after `MAX_HOURS` (default 4) and pushes checkpoints to S3 every 5 minutes. Spot
servers can be reclaimed by AWS. The pipeline checkpoints per Pokémon (sets) and per 4,000 battles (matchups, ladder), so
`RESUME_RUN=<run id>` with the same settings continues an interrupted run on a fresh server instead of starting over.
For a fresh experiment locally, use a new `--out` folder: an old one's checkpoints would be resumed.

With the rollout AI, one process with 64 worker threads exceeds Linux's default limit of 65,530 memory mappings per
process. That shows up as misleading "JavaScript heap out of memory" crashes even with plenty of RAM free.
`launch.sh` raises `vm.max_map_count` on the server and logs `[diag] maps=… rssKB=…` every 5 minutes. If you run the
pipeline yourself on Linux, raise it too: `sudo sysctl -w vm.max_map_count=4194304`.

## Updating for a new regulation

The roster, learnsets, items and mechanics come from Pokémon Showdown. The npm release only goes up to Reg M-B,
so `vendor/pokemon-showdown` holds a build of upstream `smogon/pokemon-showdown` (commit `d6014434`, simulator, data
and lib only). To target a new regulation, rebuild that folder from a newer commit (`npm install && node build`,
then copy `dist/{sim,data,lib,config}`) and set `FORMAT=<showdown format id>` when you run the pipeline.
