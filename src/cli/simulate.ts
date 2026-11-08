import { mergeRuleConfig, RULE_VERSION } from '../core/config';
import { createGame, applyAction, assertCardConservation } from '../core/engine';
import { createRng } from '../core/cards';
import { chooseAction } from '../ai/simple';

interface CliOptions {
  deals: number;
  seed: number;
  followRate: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { deals: 1000, seed: 20261107, followRate: 0.35, quiet: false };
  for (const arg of argv) {
    if (arg.startsWith('--deals=')) options.deals = Number.parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--seed=')) options.seed = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--follow-rate=')) options.followRate = Number.parseFloat(arg.slice(14));
    else if (arg === '--quiet') options.quiet = true;
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const config = mergeRuleConfig();
  const rng = createRng(options.seed);

  let state = createGame(options.seed, config, { recordEvents: false });
  let deals = 0;
  let games = 1;
  let actions = 0;
  let doubleDowns = 0;
  let passA = 0;
  let maxActionsPerDeal = 0;
  let actionsThisDeal = 0;
  const startedAt = Date.now();

  while (deals < options.deals) {
    const action = chooseAction(state, config, rng, { followRate: options.followRate });
    if (!action) {
      if (state.phase === 'GAME_OVER') {
        games += 1;
        state = createGame(options.seed + games * 7919, config, { recordEvents: false });
        continue;
      }
      throw new Error(`E_STUCK: 无可用动作（phase=${state.phase}, deal=${state.dealNo}）`);
    }

    const previousPhase = state.phase;
    const result = applyAction(state, action, config, { recordEvents: false });
    if (!result.ok) {
      throw new Error(`E_ILLEGAL_ACTION: ${result.code} ${result.message} action=${JSON.stringify(action)}`);
    }
    state = result.state;
    actions += 1;
    actionsThisDeal += 1;

    try {
      assertCardConservation(state);
    } catch (error) {
      throw new Error(`E_CARD_INVARIANT deal=${state.dealNo}: ${(error as Error).message}`);
    }

    if (
      previousPhase !== 'SETTLEMENT' &&
      (state.phase === 'SETTLEMENT' || state.phase === 'GAME_OVER')
    ) {
      deals += 1;
      const round = state.roundResult;
      if (round?.isDoubleDown) doubleDowns += 1;
      if (round?.passA) passA += 1;
      maxActionsPerDeal = Math.max(maxActionsPerDeal, actionsThisDeal);
      actionsThisDeal = 0;
    }
    if (actionsThisDeal > 0 && actionsThisDeal > 4000) {
      throw new Error(`E_STUCK: 单副牌动作数超过 4000（deal=${state.dealNo}）`);
    }
  }

  const elapsed = Date.now() - startedAt;
  const summary = {
    ruleVersion: RULE_VERSION,
    deals,
    games,
    actions,
    doubleDowns,
    passA,
    maxActionsPerDeal,
    elapsedMs: elapsed,
  };
  if (!options.quiet) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`ok deals=${deals} games=${games} actions=${actions} elapsed=${elapsed}ms`);
  }
}

main();
