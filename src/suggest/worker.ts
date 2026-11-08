/// <reference lib="webworker" />
import type { GameState } from '../core/types';
import type { RuleConfig } from '../core/config';
import { runPimc, type PimcResult } from './pimc';

export interface PimcRequest {
  id: number;
  hash: string;
  state: GameState;
  config: RuleConfig;
}

export interface PimcResponse {
  id: number;
  hash: string;
  result: PimcResult | null;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PimcRequest>) => void) | null;
  postMessage: (message: PimcResponse) => void;
};

scope.onmessage = (event) => {
  const { id, hash, state, config } = event.data;
  let result: PimcResult | null = null;
  try {
    result = runPimc(state, config, 'S');
  } catch {
    result = null;
  }
  scope.postMessage({ id, hash, result });
};
