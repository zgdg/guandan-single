import { performance } from 'node:perf_hooks';
import { mergeRuleConfig, RULE_VERSION } from '../core/config';
import {
  applyAction,
  createGame,
  getCurrentSeat,
  getLegalPlays,
} from '../core/engine';
import { createRng } from '../core/cards';
import type { EngineAction, GameState, Seat } from '../core/types';
import { chooseAction } from '../ai/simple';
import { chooseAiAction } from '../ai/policy';
import { DIFFICULTY, type AiDifficulty } from '../ai/persona';

/**
 * 引擎吞吐基准（可重复执行）：npm run bench [-- --deals=.. --ai-samples=.. --rollout-deals=..]
 *
 * 覆盖：合法出牌枚举、动作应用、整副牌 L1 rollout、L1/L2/L3 单步决策。
 * 全部使用固定 seed，同一机器上可重复对比。
 */

interface BenchOptions {
  deals: number;
  aiSamples: number;
  rolloutDeals: number;
  seed: number;
  followRate: number;
  json: boolean;
}

function parseArgs(argv: string[]): BenchOptions {
  const options: BenchOptions = {
    deals: 20,
    aiSamples: 600,
    rolloutDeals: 50,
    seed: 20261107,
    followRate: 0.6,
    json: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--deals=')) options.deals = Number.parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--ai-samples=')) options.aiSamples = Number.parseInt(arg.slice(13), 10);
    else if (arg.startsWith('--rollout-deals=')) options.rolloutDeals = Number.parseInt(arg.slice(16), 10);
    else if (arg.startsWith('--seed=')) options.seed = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--follow-rate=')) options.followRate = Number.parseFloat(arg.slice(14));
    else if (arg === '--json') options.json = true;
  }
  return options;
}

interface Timed {
  name: string;
  durations: number[];
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)));
  return sorted[index]!;
}

function summarize(run: Timed): Record<string, number | string> {
  const sorted = [...run.durations].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  return {
    name: run.name,
    samples: sorted.length,
    mean: round(mean),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function timeIt(run: (() => void) | (() => unknown)): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** 进度与慢样本只写 stderr，不污染可复制的基准表格。 */
function progress(message: string): void {
  process.stderr.write(`[bench] ${message}\n`);
}

const SLOW_SAMPLE_MS = 200;

/** 收集真实对局中的局面池：用 L1 贪心驱动，不记录事件。 */
function collectPool(options: BenchOptions, config: ReturnType<typeof mergeRuleConfig>) {
  const rng = createRng(options.seed);
  const pool: { state: GameState; action: EngineAction; seat: Seat }[] = [];
  let state = createGame(options.seed, config, { recordEvents: false });
  let deals = 0;
  let games = 1;
  let guard = 0;

  while (deals < options.deals) {
    guard += 1;
    if (guard > 200_000) throw new Error('E_STUCK: 基准局面池生成超时');
    const action = chooseAction(state, config, rng, { followRate: options.followRate });
    if (!action) {
      if (state.phase === 'GAME_OVER') {
        games += 1;
        state = createGame(options.seed + games * 7919, config, { recordEvents: false });
        continue;
      }
      throw new Error(`E_STUCK: phase=${state.phase} deal=${state.dealNo}`);
    }
    if (state.phase === 'PLAYING') {
      pool.push({ state, action, seat: getCurrentSeat(state)! });
    }
    const previousPhase = state.phase;
    const result = applyAction(state, action, config, { recordEvents: false });
    if (!result.ok) throw new Error(`E_ILLEGAL_ACTION: ${result.code} ${result.message}`);
    state = result.state;
    if (
      previousPhase !== 'SETTLEMENT' &&
      (state.phase === 'SETTLEMENT' || state.phase === 'GAME_OVER')
    ) {
      deals += 1;
    }
  }
  return pool;
}

function measureRollout(
  options: BenchOptions,
  config: ReturnType<typeof mergeRuleConfig>,
): Timed {
  const durations: number[] = [];
  for (let index = 0; index < options.rolloutDeals; index += 1) {
    const rng = createRng((options.seed + index * 7919) >>> 0);
    let state = createGame((options.seed + index * 7919) >>> 0, config, { recordEvents: false });
    const started = performance.now();
    let actions = 0;
    while (state.phase !== 'SETTLEMENT' && state.phase !== 'GAME_OVER') {
      const action = chooseAction(state, config, rng, { followRate: options.followRate });
      if (!action) throw new Error(`E_STUCK: phase=${state.phase} deal=${state.dealNo}`);
      const result = applyAction(state, action, config, { recordEvents: false });
      if (!result.ok) throw new Error(`E_ILLEGAL_ACTION: ${result.code} ${result.message}`);
      state = result.state;
      actions += 1;
      if (actions > 4000) throw new Error('E_STUCK: 单副牌动作数超过 4000');
    }
    const elapsed = performance.now() - started;
    if (elapsed >= SLOW_SAMPLE_MS) {
      progress(`慢 rollout #${index} seed=${(options.seed + index * 7919) >>> 0} 耗时=${elapsed.toFixed(0)}ms`);
    }
    durations.push(elapsed);
  }
  return { name: '整副牌 L1 rollout（发牌→结算）', durations };
}

function stride<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const picked: T[] = [];
  const step = items.length / count;
  for (let index = 0; index < count; index += 1) {
    picked.push(items[Math.floor(index * step)]!);
  }
  return picked;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const config = mergeRuleConfig();

  // 预热：让 JIT 与模块初始化不落在正式样本里。
  collectPool({ ...options, deals: Math.min(2, options.deals) }, config);

  progress(`局面池生成中（${options.deals} 副）`);
  const pool = collectPool(options, config);
  const entries = stride(pool, options.aiSamples);
  progress(`局面池=${pool.length}，取样=${entries.length}`);

  const enumeration: Timed = { name: '合法出牌枚举 getLegalPlays', durations: [] };
  const application: Timed = { name: '动作应用 applyAction', durations: [] };
  const ai: Record<AiDifficulty, Timed> = {
    L1: { name: 'AI 单步决策 L1', durations: [] },
    L2: { name: 'AI 单步决策 L2', durations: [] },
    L3: { name: 'AI 单步决策 L3（采样搜索）', durations: [] },
  };

  for (const entry of entries) {
    enumeration.durations.push(
      timeIt(() => {
        getLegalPlays(entry.state, config, entry.seat);
      }),
    );
    application.durations.push(
      timeIt(() => {
        applyAction(entry.state, entry.action, config, { recordEvents: false });
      }),
    );
  }
  progress('枚举/应用测量完成');

  for (const entry of entries) {
    for (const difficulty of ['L1', 'L2', 'L3'] as AiDifficulty[]) {
      const rng = createRng((options.seed + entry.state.events.length * 131 + entry.state.dealNo) >>> 0);
      const duration = timeIt(() => {
        chooseAiAction(entry.state, config, entry.seat, rng, { difficulty });
      });
      if (duration >= SLOW_SAMPLE_MS) {
        progress(
          `慢样本 ${difficulty} deal=${entry.state.dealNo} seat=${entry.seat}` +
            ` hand=${entry.state.players[entry.seat].hand.length} 耗时=${duration.toFixed(0)}ms`,
        );
      }
      ai[difficulty].durations.push(duration);
    }
  }
  progress('AI 单步测量完成');

  const rollouts = measureRollout(options, config);
  progress('整副 rollout 测量完成');

  const runs = [enumeration, application, ...(['L1', 'L2', 'L3'] as AiDifficulty[]).map((item) => ai[item]), rollouts];
  const stats = runs.map(summarize);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ruleVersion: RULE_VERSION,
          node: process.version,
          options,
          poolStates: pool.length,
          stats,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`引擎吞吐基准  ruleVersion=${RULE_VERSION}  node=${process.version}`);
  console.log(
    `deals=${options.deals}  局面池=${pool.length}  单步样本=${entries.length}  rollout=${options.rolloutDeals}  seed=${options.seed}`,
  );
  console.log('');
  console.log(
    '       指标                         样本     mean      p50       p95       p99       max (ms)',
  );
  for (const item of stats) {
    console.log(
      `${String(item.name).padEnd(32)}${String(item.samples).padStart(8)}` +
        `${Number(item.mean).toFixed(2).padStart(9)}` +
        `${Number(item.p50).toFixed(2).padStart(9)}` +
        `${Number(item.p95).toFixed(2).padStart(9)}` +
        `${Number(item.p99).toFixed(2).padStart(9)}` +
        `${Number(item.max).toFixed(2).padStart(9)}`,
    );
  }
  console.log('');
  console.log('L3 预算参数：', JSON.stringify({ ...DIFFICULTY.L3 }));
}

main();
