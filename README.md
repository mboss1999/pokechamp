# Champions Team Builder

A team builder for **Pokémon Champions ranked singles** (Showdown format `[Gen 9 Champions] BSS Reg M-C`:
bring 6, pick 3, level 50, 66 stat points with at most 32 per stat, Champions item pool), and (in progress)
**doubles** (`[Gen 9 Champions] VGC 2026 Reg M-C`: bring 6, pick 4, open team sheets).
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

3. **Draft practice**: pick 3 of your 6 and a lead against an opponent you see only by species, as at team preview
   in Champions. Use one of your built teams or paste a Showdown team; the opponent is a random meta team or species
   you paste from the ladder. The simulator analyses the matchup while you think, then tells you what your pick cost
   in win rate, the best picks, and what the opponent should bring. Analysis levels:
   - **Quick / Normal** (~2 / ~4 min): every battle piloted by the fast heuristic AI. Fine for a rough read, but
     judged by a full rollout-AI analysis, Normal's picks lose about 3 points of win rate more than Strong's.
   - **Strong AI** (15–25 min on an M-series Mac, longer in Low Power Mode): the hybrid solver below, with the rollout
     AI playing the battles that decide the verdict. If your pick is outside the options it analysed first, it grades
     your pick on top (about half a minute) when you lock in.

Your collection is stored in the browser (localStorage). Use **Import / export** to back it up.

### Tune & validate a team

The precomputed sets are each Pokémon's best *in general*, tuned with random teammates. Every team card re-tunes the sets
for that exact team (`sim/refine.js`) and shows the tuned sets and the validation as soon as they exist. There is no button
and nothing to wait for:

- **Precomputed.** Whenever your collection (or the Mega setting) changes, the app tells the server, which builds the same
  teams the Team Builder will show, with and without Megas, and starts tuning all of them right away (`sim/tuner.js`).
- **On AWS Lambda** for the teams on screen and the current Mega setting. With the function deployed
  (`aws/lambda-deploy.sh`, needing the permissions in `aws/lambda-policy.json` attached to the AWS user), the tuning loop
  runs in the app's server and each stage fans its battles out over up to 800 Lambda invocations at once. Measured
  2026-11-14: five teams tuned at once in 40–84 s each, 1.2M battles for the five, roughly $0.25 a team. Since the switch
  to the new pilots (2026-11-15) a team takes 40 s–6 min and roughly $0.35–1.70, most of it the strong AI's battles.
  Spend is capped at 10 million battles a day (about $10; `TUNE_LAMBDA_DAILY_BATTLES`, a strong-AI battle counts as
  25), then EC2 takes over.
- **On one EC2 machine** for the other Mega setting's teams, and for everything when Lambda isn't set up or is capped:
  one 64-core c7g.16xlarge Spot machine (`aws/launch.sh` running `sim/tune-batch.js`), results streaming back through S3
  as each team finishes, then the machine terminates itself. About 8× cheaper per battle than Lambda but minutes
  including boot. If you look at one of its teams before it's done, Lambda takes it over. At most 40 launches a day
  (`TUNE_CLOUD_DAILY`).
- **Cached.** Every finished tuning is saved in `web/data/tuned.json`, keyed by the team's sets, the simulation results,
  the budget and the algorithm version, so it is instant from then on. New simulation results retire the old tunings.
- **Fallback.** With no AWS (`TUNE_CLOUD=0 ./start.sh` forces this), or if a cloud run fails, this computer tunes the
  teams one at a time, most wanted first.

What a tuning does:

Two pilots play, as in the set search: the fast `heuristic2` plays the search, the strong `rollout4all` checks status
moves and plays the validation (`TUNE_FAST_AGENT`, `TUNE_STRONG_AGENT`). The fast pilot undervalues some setup and
tactical moves (it would trade Blaziken's Swords Dance for Poison Jab and Dragapult's Disable for Fire Blast, which the
strong pilot rates as no better or worse), so it can't be the last word on them.

1. **Baseline:** measure the team in full 6v6 bring-3 battles against strong meta teams. Opponents are sampled by rating
   and respect Item Clause.
2. **Tune each member in turn:** try up to 7 alternatives (its precomputed alternates, plus single changes to a move,
   item, ability or spread) with the other five fixed. A candidate may not add a second attack doing the same job as
   one already there (same type, category, priority and pivoting). All candidates play identical battles, the top two
   get a larger separate sample, and a change is kept only if it wins there by a one-sided 95% margin. A change that
   adds or removes a status move must also win by that margin with the strong pilot.
3. **Validate:** compare the original and tuned teams on a fresh set of battles played by the strong pilot. If the tuned
   team isn't better there, the original sets are kept (`rejectedTuning` records what was tried). The reported numbers
   always come from this fresh sample.
4. **Repeat** the member-by-member pass until a whole pass changes nothing (at most 4 passes).

The app always uses the **rigorous** budget (`BUDGETS` in `sim/refine.js`): 10× the base samples (1,800 screening and
6,000 confirming battles per comparison with the fast pilot; 2,000 per status check and 3,200 per validation side with
the strong pilot), roughly 100k–450k fast and 3k–20k strong battles per team. On Lambda the members' battles are
played speculatively in parallel (every remaining member against the current team at once, redone after an accepted
change), which gives exactly the one-by-one result with far fewer round trips at the cost of ~45% more battles; on local
cores and EC2, where total battles are the limit, members go strictly one by one. On the first 45-species test collection
(2026-11-14, old sets and heuristic pilot),
rigorous tuning improved all five teams by +1.7 to +7.3 points on 5,000 fresh validation battles, where Normal had mostly
changed nothing. `sim/tune-study.js` measures whether bigger
samples would still change the outcome. Its first run (12 Team Builder teams from random 45-species collections, every
outcome judged on the same 20,000 fresh paired battles) found tuning not yet converged at 5×:

| Samples | Judged gain over untuned | Shortfall vs best found | Battles per team |
|---|---|---|---|
| 1× (old Normal) | +1.9 pts | 5.3 pts | 28k |
| 2.5× (old Thorough) | +3.7 | 3.6 | 96k |
| 5× | +4.3 | 2.9 | 212k |
| 10× | +6.0 | 1.2 | 476k |

10× beat 5× by +1.7 ± 1.1 pts (paired over teams), above the project's 1-point bar, so rigorous is now 10×. A second run
(16 new teams, 10× vs 20×, same judging) found 20× ahead by only +0.5 ± 1.0 pts (judged gain +5.5 vs +6.1 pts, shortfall
1.7 vs 1.2) for twice the battles (375k vs 760k per team): below the bar, so 10× is where tuning stops. The result also shows how often each member is brought and leads,
and which meta Pokémon beat the team most often.

## How the numbers are produced

| Stage | What it simulates | Output |
|---|---|---|
| `sets` | For each of the 311 roster entries (each Pokémon, plus each Mega Stone option), about 15–25 candidate sets are generated from archetypes (all-out attacker, setup sweeper, bulky attacker, defensive support, Trick Room). Each candidate plays 3v3 battles with random teammates against random opponent teams, with the same opponents and seeds for every candidate. Successive halving picks a starting set, then a coordinate-descent search (`sim/setsearch.js`, below) tries every alternative for each move slot, the item, ability and spread. Two passes, so sets adapt to the improved field. | Best set plus up to 3 alternatives with different items |
| `matchups` | 1v1 battles between every pair of best sets, played from both sides. Each result is scored by HP margin, not just win/loss: a win scores 0.5 plus half the winner's remaining HP. | N×N matchup matrix |
| `ladder` | Random 6v6 team battles. The AI picks 3 at team preview (bring 6, pick 3). A logistic (Bradley–Terry) model is fitted to the 3 Pokémon each side actually brought. | Elo-style rating, pick rate, win rate |
| `export` | Bundles everything. | `web/data/results.json` |

The team builder scores a team by how well it answers the field, weighting stronger threats more heavily. For each
threat it blends the 1v1 win rates of your three best answers (50/30/20), because you bring three. Only one Pokémon per
side can Mega Evolve in a battle, so at most one of those three answers may be a Mega; the number of Megas on a team then
falls out of the search, with no cap needed. The rates are shrunk
toward 50% according to how many battles back them. It also adds a small bonus for the members' own ratings. It searches with greedy construction, swap-based local search and several restarts.

### Battle AIs

`sim/battle.js` has two kinds of pilot:

- **heuristic** (`sim/agent.js`, the default): fast, about 350 battles/s on a 10-core Mac. Details below.
- **heuristic2**: the same pilot with rules for what Protect, Substitute, Taunt, Encore, Disable, setup, recovery,
  Will-O-Wisp, phazing, Wish and Fake Out's flinch achieve in the current position (v1 gave Protect a flat 0.02 and Taunt/Encore 0.15, so it
  almost never used them). On teams of Showdown's hand-built Champions random-battle sets, which carry many status
  moves, it beats heuristic 51.5% ± 0.7 over 3,000 mirrored games (`node sim/compare.js --a heuristic2 --b heuristic
  --teams curated`); no rule group made it worse when switched off (`V2_OFF=protect,...`). The sets stage uses it.
- **rollout4all**: rollout4 on top of heuristic2 that simulates every one of its moves, not only the heuristic's
  top 3 (and 3 opponent replies instead of 2). It beats rollout4 53.7% ± 1.4 on curated teams and ties it on meta
  teams (50.0% ± 1.4). The set search uses it as the strong pilot.
- **rollout4** (`sim/lookahead.js`): for each decision, plays its top options against the opponent's likely replies
  on a copy of the battle for one turn plus 4 heuristic turns, then scores the position. It uses "expected" dice so it
  can't peek at real rolls. It beats the heuristic **62.7% ± 3.1** over 600 mirrored games (`node sim/compare.js
  --a rollout4`), but it is roughly 75× slower per battle. Choose it per stage: `--agent` sets the default,
  `--sets-agent`, `--matchups-agent` and `--ladder-agent` override it (on AWS: `AGENT`, `SETS_AGENT`, …).
  Set tuning plays the vast majority of the battles, so the recommended mix is the fast AI there and the rollout AI
  for matchups and the ladder, which are what rank Pokémon (`MATCHUPS_AGENT=rollout4 LADDER_AGENT=rollout4`).
  Using it for everything took about 17 hours per tuning pass on a 64-core server, which is not worth it. Static one-turn lookahead (`lookahead`) was no better than the heuristic (51%), because it can't see the
  payoff of setup moves.

  Since 2026-11-14 rollout4 is about 1.9× faster with identical decisions: damage estimates are memoized per battle
  state and shared across the lookahead's battle copies (keyed on everything the damage formula reads, including
  type changes and field-wide abilities such as Fairy Aura; `CHECK_DAMAGE_MEMO=1` recomputes every cached value and
  counts mismatches; the shared cache is only used inside a lookahead decision and holds at most 100,000 entries,
  `SHARED_DAMAGE_MEMO_MAX`: before 2026-11-15 it was always on with a 400,000-entry cap, ~690 MB per worker thread,
  which exhausted a 64-thread machine's 128 GB), and a decision stops simulating once the heuristic's own choice wins against every reply,
  since nothing can then score higher. Each simulated copy gets its own dice per (decision, option, reply), so results
  don't depend on how many simulations ran before.

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
- `StrongDraft` in `sim/draft.js` (bench levels `x4-*`, the app's **Strong AI**) gets rollout-AI verdicts for ~1/8
  of the rollout battles a full rollout4 solve needs (~5k instead of ~40k). The heuristic screens all 3,600 cells;
  the rollout AI plays my 10 best options (by the heuristic) against the opponent's 8 most dangerous replies; then,
  twice, it probes every other reply against my equilibrium mix and adds the most dangerous ones; finally it grades my
  options against the opponent's equilibrium replies. Why this shape: in the benchmark the rollout AI's best pick
  was always tied with one of the heuristic's top 10, but the heuristic is a poor guide to the *opponent's* best
  replies (the rollout AI's main replies were often 20th–50th on the heuristic's list), so those are found by the
  rollout AI itself.

  Benchmark (AWS run 20261114-211130, files in `out-aws/bench-20261114-211130/`; 20 matchups judged by the full
  rollout4 solve `r4-s1`): `x4-s1` regret 1.9 ± 0.9 pp, and 1.8 ± 0.7 pp in an independent replicate (`--salt 1`),
  against 4.7 ± 1.7 pp for the heuristic at the same size (`h-s1`, the app's Normal) and 3.2 ± 1.3 pp even at 16×
  the samples (`h-s16`). Paired on the same judge, `x4-s1` picks 2.8 ± 1.6 pp better than `h-s1`. An `r4-s1`-size
  judge is itself noisy (it scores a near-perfect pick at ~1.0 pp regret, and a same-size replicate at ~1.5 pp), so
  `x4-s1` is about as good as the full rollout4 solve at an eighth of its rollout battles; certifying regret under
  1 pp would need a larger judge. A rollout2 pilot (`x2-s1`) plays rollout4 evenly (49.7% ± 3.2 over 600 games) but
  drafted 0.45 ± 1.5 pp worse and was only 1.23× faster, so the app keeps rollout4. On a 64-core c7g, one `x4-s1`
  solve takes ~9.5 min on 8 cores.

### Set search

`sim/setsearch.js` replaced the sets stage's hill climb (6 random single changes, twice, keeping the noisy best)
after the move-choice audit below. From the archetype screen's winner it sweeps each move slot, the item, the
ability and the spread in turn, with every alternative: all status moves the pilot has a rule for and the two
strongest attacks of each type. A move can't join an attack of the same type, category and priority (no more
Dragon Darts with Dragon Claw). Each sweep is a paired race on identical battles: screen everything, refine the top
4 on fresh battles, then confirm the best against the current choice on more fresh battles, switching only on a
one-sided 95% win. Sweeps repeat until a round changes nothing (at most 3).

The fast pilot still misjudges status moves, so the strong pilot (rollout4all) has the last word on them: a change
that adds or removes a status move must also win with it, the three best-screened status moves get a rollout4all
race of their own in the slot that was easiest to replace, and the final set must not be clearly worse than the
starting set under rollout4all. `node sim/setsearch-run.js --ids dragapult,garchomp --pool lambda --scale 4 --check
rollout4all` runs it on chosen entries against the current meta and writes a results file `sim/audit-moves.js
--results` can audit.

### Move-choice audit

`sim/audit-moves.js` checks the precomputed sets' moves with paired battles (every variant plays identical
opponents, partners and dice): `--mode redundancy` tests sets with two attacks of the same type and category (is
the weaker one a dead slot, and does any other move do better there?), `--mode status` tries status and tactical
moves in the weakest slot of the top-rated entries, `--mode pairs` replays explicit variant lists, with
`--agent rollout4` for the stronger pilot. Use `--pool lambda` to run it on AWS Lambda.

The first audit (2026-11-14, 70 slots, 4,000 paired battles per variant) found the set search unconverged: 25 slots
were never used by the pilot (removing the move changed no battle, e.g. Dragapult's Dragon Claw next to Dragon
Darts), 18 had a single-move change worth over 2 points (up to +7), and the heuristic pilot almost never clicks
Protect, Substitute, Taunt or Encore, so the search can't value them. The rollout AI only considers the
heuristic's top three moves, so it shares that blind spot.

### Ladder benchmark

Do the simulation's choices hold up against what strong human players use? Two tools compare against Showdown's own
data for the format:

- `sim/ladder-bench.js` reads the ladder usage statistics (`https://www.smogon.com/stats/<month>/chaos/gen9championsbssregmc-1760.json`,
  parsed by `sim/ladderstats.js`), builds each popular Pokémon's modal ladder set (4 most used moves, most used item,
  most used spread) and races it against our set on identical battles, in our simulated field (`--field sim`) or a
  field drawn by ladder usage with ladder sets (`--field ladder`), with any pilot. `ladderMoves` (our item and spread
  with the ladder's moves) separates moves from items; `--compare other/results.json` adds a third set (e.g. from
  `sim/setsearch-run.js`). A ladder set that beats ours under our own pilot means the search missed it; ours beating
  the ladder's is a finding only if the pilot can play the ladder set's idea (the report flags status moves the pilot
  has no rule for).
- `sim/team-bench.js` takes real teams from public replays of top-100 ladder players (team preview gives the six
  species; Mega Evolution, moves and items come from the replay where revealed, the rest from the ladder's modal
  set) and plays the Team Builder's five teams and every real team in a round robin against the real teams, same pilot
  on both sides. A real team scores ~50% against its own field by symmetry, so the builder's score says how its teams
  compare with a typical strong ladder team.

  ```bash
  node sim/ladder-bench.js --stats chaos.json --top 45 --field ladder --agent rollout4all --n 800 --pool lambda
  node sim/team-bench.js --replays out/team-bench/replays --stats chaos.json --agent rollout4all --games 2 --pool lambda
  ```

First run (2026-11-15, October 2026 stats at the 1760 cutoff, 87,848 battles; 248 real teams from 503 replays of
top-100 players, Elo 1250+; results in `out/ladder-bench/` and `out/team-bench/`):

- **Teams.** Judged by rollout4all on both sides, the Team Builder's five teams score 51–66% against the real teams
  (66.5, 61.9, 51.2, 58.3, 59.5% ± 2.2; the real teams' own median is 50.6%, 90th percentile 59.9%), so its best team
  sits at the 98th percentile of strong ladder teams. Its teams look nothing like the ladder's (Annihilape, Hydreigon,
  Conkeldurr, Indeedee, Clefable: 0.1–10% usage), and the rating order correlates only 0.37 (Spearman, top 60) with
  ladder usage. Bulky setup sets (Bulk Up Rage Fist, Unaware Cosmic Power Clefable) are what an AI-piloted field
  struggles with; humans answer them with Taunt / Encore / Haze, so treat their ratings as an upper bound.
- **Bugs found and fixed** (none of these were simulation findings):
  - the pilot's damage estimate (`sim/agent.js` computeDamage) never ran a move's own type / power / accuracy handlers
    and forced every move not to crit: Weather Ball in sun was estimated at 22% of its real damage, Triple Axel at 0,
    Flower Trick at 67% (lost its guaranteed crit), Blizzard in snow and Hurricane in rain at ~67%, Zap Cannon with
    No Guard at 50%, Protean / Libero coverage moves at ~64% (no type-change STAB). Estimates now match the engine
    within a few percent for all of them (accuracy now follows the engine's accuracy events and stages).
  - in the sets stage's second pass, a small halving race (~340 battles, no paired confirmation, no strong-pilot
    check) could replace the incumbent: 44 of 344 final sets got their item that way, mostly Quick Claw (9) and Bright
    Powder (10), which the ladder never uses. Later passes now start the descent from the incumbent.
  - the search's move pool kept the two strongest attacks per type by base power, which left out Flower Trick,
    Weather Ball and Triple Axel. Attacks with their own power / type / accuracy logic are now always tried, and
    `--ladder-stats` adds every move the ladder uses (>= 10%) and seeds the ladder's modal set as a first-pass
    candidate.
  - heuristic2 had no rule for Wish (Umbreon 91% on the ladder) or for Fake Out's flinch; it has both now.
- **Sets** (22 Pokémon, ladder field, rollout4all, 800 paired battles each, ± 2 pp): the ladder's set beat ours
  clearly for 8 (Cinderace +6.9, Charizard-Mega-X +5.6, Floette-Mega +5.1, Clefable-Mega +4.9, Greninja +4.9 from
  Protean, Ninetales-Alola +4.8, Raichu-Mega-Y +4.3, Metagross-Mega's moves +5.0), tied for 9, and lost clearly for 5
  (Archaludon −8.4, Gholdengo −7.6, Grimmsnarl −7.1, Pelipper −5.8, Scizor −4.8). Re-searching those 22 with the fixed
  pilot and pool (`sim/setsearch-run.js`, from the current sets) changed 9 and closed part of the gap (Ninetales
  +5.1, Raichu +2.9, Charizard-X +2.9, Cinderace +2.6, Kingambit +2.4 over the old set); the rest need changes to
  several dimensions at once (Clefable-Mega's Bold Moonlight Flamethrower set), which coordinate descent from our
  set can't reach but the seeded ladder candidate can. Where ours wins, the ladder set leans on what this pilot plays
  poorly or what depends on teammates: dual screens + Parting Shot (Grimmsnarl), Damp Rock rain (Pelipper),
  U-turn pivoting (Scizor), so those are not clean findings either. The sets stage plays against our own simulated
  meta, which differs from the ladder's; part of each gap is that field.

The fixes change every battle, so the published results need a full re-run of the pipeline (with `--ladder-stats`)
before they apply.

**Pilot convergence** (2026-11-15, `out/convergence/`, fixed pilot): is the battle AI strong enough that a stronger
one would not change the tool's decisions?

- Strength keeps rising with look-ahead: rollout8all beats rollout4all 51.9% ± 1.5, rollout16all beats rollout8all
  51.8% ± 1.2 (3,000 mirrored games each). `sim/exploit-test.js` found that stronger opponents do not punish the
  sim's favourite bulky setup Pokémon (Clefable, Annihilape, Azumarill, Conkeldurr, Umbreon, Corviknight,
  Scizor-Mega) more than popular attackers: −13.4 vs −14.2 pp (rollout4all opponents) and −17.8 vs −18.2 pp
  (rollout8all), against a heuristic2-piloted subject.
- Decisions do not change. Set choice (22 Pokémon × 4 candidate sets, 800 paired battles each, ladder field), judged by
  an independent rollout16all run: rollout4all's picks lose 0.85 ± 0.32 pp, rollout8all's 0.83 ± 0.34, rollout16all's
  own picks on other seeds 0.58 ± 0.26 (the noise floor). Team choice (the builder's 7 distinct top teams vs the 248
  real teams, ~990 games each): rollout4all and rollout16all pick the same best team; rollout8all picks the runner-up,
  which the two rollout16all runs score 68.1 and 66.2% against 68.5 and 69.0%, a gap inside the judges' own noise.
  The builder's teams score higher against real teams as the pilot gets stronger (mean 60.6% with rollout4all, 63.7%
  with rollout16all), so their edge is not an artifact of weak play.
- So within this family of AIs (rules + rollouts), pilot strength past rollout4all is not what limits team building.
  A blind spot shared by the whole family can't show up in these tests; only a differently built player (humans, or
  an RL agent) can find one. The heuristic2 Unaware rule found this way (opponents set up into Unaware Clefable on 59
  of 683 turns) is now fixed, though it moves overall results by only 50.1% ± 0.1.

### Team preview: the AI's weakest link (2026-11-16)

Every pilot picks its three at team preview by one fixed rule (the three with the best summed matchup scores), so a
team brings the same three against a given opponent every time. Two consequences, found while building the
"Strongest teams" results (`out/strongest/`):

- **Counter-teams are artifacts under fixed picks.** In the first double-oracle run 12 of 28 team pairs ended 90-100%
  one way over 300 games; with both sides choosing their three by equilibrium (`sim/preview-game.js`: the fast pilot
  screens all 20x20 trio pairings, the strong pilot decides each side's 6 best) a 100% pair became 17%, others 34-64%.
  The double oracle now uses these team-preview-game payoffs (`--payoff preview`) and a randomized preview in its
  search (`agent~pT` pilots pick trio t with probability ~ exp(score / T)).
- **The ladder team search optimized around the fixed pick.** Searched teams beat their Team Builder starting teams
  by 7-13 points against the ladder field with fixed picks (replicated on fresh seeds and on each part of the field),
  but by +2 to +6 with randomized picks at T = 0.5 and about 0 at T = 1, and the starting team scored highest
  (66.4% against 61.5-64.6%) as a team-preview game against 100 field teams (`sim/preview-check.js`). The starting
  team rose from 52% to 62-66% once its three wasn't forced: the fixed rule picked badly for it, and the search's
  swaps mostly changed which three the rule picks.

So team-level results must be judged with good preview play on both sides (the preview game), and the practical ladder
search has to be redone that way; the preview rule itself is the first thing to improve in the battle AI.

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

### Doubles

`FORMAT=gen9championsvgc2026regmc` runs everything in doubles (`sim/format.js` reads the format, its bring size and
game type). The pipeline then uses the doubles pilot, Showdown's curated doubles movepools
(`doubles-sets.json`) as seeds, 3 partners per set-search battle, and writes `web/data/doubles-results.json`:

```bash
FORMAT=gen9championsvgc2026regmc node sim/pipeline.js --limit 12 --scale 0.25 --passes 1 --out out/dtest
```

- **Pilot** (`sim/dagent.js`, agent `dheuristic`): the singles agent's damage estimates and move values, plus target
  choice, spread moves (0.75x per target; ally-hitting moves like Earthquake are penalised unless the partner
  protects), both slots chosen together (no attack into a foe the partner already KOs, a bonus for double-target
  KOs), and rules for Fake Out, Protect, Follow Me / Rage Powder, Helping Hand, Tailwind, Trick Room, Wide Guard and
  speed control. Team preview brings the 4 with the best matchups and leads with Fake Out, speed control and
  Intimidate users. On Showdown's random doubles teams it beats `dgreedy` (every slot clicks its most damaging
  attack) 69.5% of 400 games and plays itself to 50.5%. There is no doubles lookahead pilot yet, so the set search
  has no strong-pilot check in doubles.
- **Matchups** are 2v2: each Pokémon gets a meta partner, and the two battles of a pair swap the partners so partner
  luck cancels. The team builder blends a team's 4 best answers to each threat (40/30/20/10).
- **App:** the Singles / Doubles switch in the header picks the results file. Team tuning and draft practice are
  singles-only for now.

### On AWS

```bash
aws/setup.sh                 # once: private S3 bucket + an EC2 role limited to that bucket
SCALE=4 aws/launch.sh        # one c7g.16xlarge Spot instance; uploads results to S3 and terminates itself
aws/status.sh                # progress
aws/fetch.sh                 # copy results into web/data/results.json
```

For the full pipeline, `aws/launch-sharded.sh` splits the work over 4 Spot machines (`SHARDS`), each running
`sim/shard.js` on a quarter of the roster: set search pass 1, pass 2 against everyone's merged pass 1, then a
quarter of the matchup and ladder battles; shard 0 fits the ratings and writes `results.json` to
`s3://<bucket>/runs/<group>/shared/`. The machines only exchange files through S3, so nothing has to stay running
on your computer. It starts from the current `web/data/results.json` sets and weights partners and opponents by
its ratings. `aws/status-sharded.sh` shows every shard; after a Spot interruption, `GROUP=<group> ONLY="<k>"
aws/launch-sharded.sh` relaunches shard k, which resumes from its checkpoints.

The instance has a hard shutdown after `MAX_HOURS` (default 4) and pushes checkpoints to S3 every 5 minutes. Spot
servers can be reclaimed by AWS. The pipeline checkpoints per Pokémon (sets) and per 4,000 battles (matchups, ladder), so
`RESUME_RUN=<run id>` with the same settings continues an interrupted run on a fresh server instead of starting over.
For a fresh experiment locally, use a new `--out` folder: an old one's checkpoints would be resumed.

Other long jobs (benchmarks, team search, preview checks, tuning against the field, the double oracle) belong on Spot
too: per vCPU-hour a c7g/c8g.16xlarge Spot machine costs about an eighth of Lambda. Keep Lambda for the app and for
quick checks. `aws/spot-job.sh` runs one command on a Spot machine and survives reclaims:

```bash
EXTRA_FILES='out/ladder-bench/chaos-2026-10-1760.json' aws/spot-job.sh start bench-sets \
  'node sim/ladder-bench.js --stats out/ladder-bench/chaos-2026-10-1760.json --agent rollout4all~v --n 800 --checkpoint out/bench-sets.ckpt --out out/bench-sets.json'
aws/spot-job.sh watch bench-sets      # relaunches after a reclaim (falls back across instance types) until done
aws/spot-job.sh fetch bench-sets out/aws-bench-sets
```

`--checkpoint FILE` (sim/checkpoint.js; ladder-bench, team-bench, team-search, preview-check, tune-field,
double-oracle) stores battle results as they finish, keyed by the battles themselves. These scripts are deterministic
given their battle results, so the same command started again replays to where it stopped without playing those
battles again; put the file under `out/` so it reaches S3 with the 5-minute uploads. For multi-step jobs, ship a small
script with `EXTRA_FILES` and give each step its own checkpoint file. The watcher gives up after `MAX_LAUNCHES` (20)
launches or `MAX_BOX_HOURS` (24) machine-hours in total.

With the rollout AI, one process with 64 worker threads exceeds Linux's default limit of 65,530 memory mappings per
process. That shows up as misleading "JavaScript heap out of memory" crashes even with plenty of RAM free.
`launch.sh` raises `vm.max_map_count` on the server and logs `[diag] maps=… rssKB=…` every 5 minutes. If you run the
pipeline yourself on Linux, raise it too: `sudo sysctl -w vm.max_map_count=4194304`.

## Updating for a new regulation

The roster, learnsets, items and mechanics come from Pokémon Showdown. The npm release only goes up to Reg M-B,
so `vendor/pokemon-showdown` holds a build of upstream `smogon/pokemon-showdown` (commit `d6014434`, simulator, data
and lib only). To target a new regulation, rebuild that folder from a newer commit (`npm install && node build`,
then copy `dist/{sim,data,lib,config}`) and set `FORMAT=<showdown format id>` when you run the pipeline.
