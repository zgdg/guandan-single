import { performance } from 'node:perf_hooks';
import { mergeRuleConfig } from '../core/config';
import { applyAction, createGame, getCurrentSeat } from '../core/engine';
import { createRng, teamOf } from '../core/cards';
import { chooseAiAction } from '../ai/policy';
import { NEUTRAL_PERSONA, personaOf, type AiDifficulty } from '../ai/persona';

/**
 * 离线强度对战：NS 队用 A 难度，EW 队用 B 难度，统计头游率/升级分/单步耗时。
 * 用法：npm run sim:arena [-- --deals=500 --a=L3 --b=L2 --seed=20261107 --personas]
 *
 * 默认两队都用中性人格，保证胜率差异只来自难度；加 --personas 才使用座位固定牌风。
 */

interface ArenaOptions {
  deals: number;
  seed: number;
  a: AiDifficulty;
  b: AiDifficulty;
  usePersonas: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ArenaOptions {
  const options: ArenaOptions = {
    deals: 500,
    seed: 20261107,
    a: 'L3',
    b: 'L2',
    usePersonas: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--deals=')) options.deals = Number.parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--seed=')) options.seed = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--a=')) options.a = normalize(arg.slice(4));
    else if (arg.startsWith('--b=')) options.b = normalize(arg.slice(4));
    else if (arg === '--personas') options.usePersonas = true;
    else if (arg === '--json') options.json = true;
  }
  return options;
}

function normalize(value: string): AiDifficulty {
  return value === 'L1' || value === 'L3' ? value : 'L2';
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))]!;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface TeamStep {
  durations: number[];
  decisions: number;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const config = mergeRuleConfig();

  let state = createGame(options.seed, config, { recordEvents: false });
  let deals = 0;
  let games = 1;
  let actions = 0;
  let nsWins = 0;
  let nsUpgrades = 0;
  let doubleDowns = 0;
  let dealStarted = performance.now();
  const dealDurations: number[] = [];
  const team: Record<'NS' | 'WE', TeamStep> = {
    NS: { durations: [], decisions: 0 },
    WE: { durations: [], decisions: 0 },
  };
  let legalFailures = 0;

  while (deals < options.deals) {
    if (state.phase === 'SETTLEMENT') {
      const next = applyAction(state, { type: 'NEXT_DEAL' }, config, { recordEvents: false });
      if (!next.ok) throw new Error(`E_NEXT_DEAL: ${next.code} ${next.message}`);
      state = next.state;
      dealStarted = performance.now();
      continue;
    }
    if (state.phase === 'GAME_OVER') {
      games += 1;
      state = createGame(options.seed + games * 7919, config, { recordEvents: false });
      dealStarted = performance.now();
      continue;
    }

    const seat = getCurrentSeat(state);
    if (!seat) break;

    const difficulty = teamOf(seat) === 'NS' ? options.a : options.b;
    const persona = options.usePersonas ? personaOf(seat) : NEUTRAL_PERSONA.params;
    const rng = createRng((options.seed + actions * 131 + state.dealNo * 17) >>> 0);
    const started = performance.now();
    const action = chooseAiAction(state, config, seat, rng, {
      difficulty,
      persona,
    });
    const elapsed = performance.now() - started;
    if (!action) throw new Error(`E_STUCK: phase=${state.phase} deal=${state.dealNo}`);
    if (state.phase === 'PLAYING') {
      team[teamOf(seat)].durations.push(elapsed);
      team[teamOf(seat)].decisions += 1;
    }

    const result = applyAction(state, action, config, { recordEvents: false });
    if (!result.ok) {
      legalFailures += 1;
      throw new Error(`E_ILLEGAL_ACTION: ${result.code} ${result.message}`);
    }
    state = result.state;
    actions += 1;

    if (state.phase === 'SETTLEMENT' || state.phase === 'GAME_OVER') {
      deals += 1;
      const round = state.roundResult;
      if (round) {
        if (round.winnerTeam === 'NS') nsWins += 1;
        if (round.winnerTeam === 'NS') nsUpgrades += round.upgrade;
        if (round.isDoubleDown) doubleDowns += 1;
      }
      dealDurations.push(performance.now() - dealStarted);
      dealStarted = performance.now();
    }
  }

  const sortedDeals = [...dealDurations].sort((left, right) => left - right);
  const summarize = (steps: TeamStep) => {
    const sorted = [...steps.durations].sort((left, right) => left - right);
    const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
    return {
      decisions: steps.decisions,
      mean: round(mean),
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)),
      max: round(sorted[sorted.length - 1] ?? 0),
    };
  };

  const report = {
    deals,
    games,
    actions,
    legalFailures,
    a: options.a,
    b: options.b,
    personas: options.usePersonas,
    nsWinRate: round(nsWins / Math.max(1, deals)),
    nsUpgradePerDeal: round(nsUpgrades / Math.max(1, deals)),
    doubleDowns,
    ns: summarize(team.NS),
    ew: summarize(team.WE),
    dealMs: {
      p50: round(percentile(sortedDeals, 0.5)),
      p95: round(percentile(sortedDeals, 0.95)),
      p99: round(percentile(sortedDeals, 0.99)),
      max: round(sortedDeals[sortedDeals.length - 1] ?? 0),
    },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`离线对战  NS=${options.a}  vs  WE=${options.b}  人格=${options.usePersonas ? '座位牌风' : '中性'}`);
  console.log(
    `deals=${deals}  actions=${actions}  NS 头游率=${(report.nsWinRate * 100).toFixed(1)}%  平均升级=${report.nsUpgradePerDeal}  双下=${doubleDowns}`,
  );
  console.log(`NS 单步: ${JSON.stringify(report.ns)}`);
  console.log(`EW 单步: ${JSON.stringify(report.ew)}`);
  console.log(`整副耗时: ${JSON.stringify(report.dealMs)}`);
  console.log(`非法动作: ${legalFailures}`);
}

main();
