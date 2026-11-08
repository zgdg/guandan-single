import type { Seat } from '../core/types';

/** 难度档位。 */
export type AiDifficulty = 'L1' | 'L2' | 'L3';

/**
 * 人格参数（规划 4.1.4）：不写死在分支里，统一由配置表驱动。
 * - aggression：进攻倾向，越高越爱压、越早用炸弹。
 * - bombThreshold：对手剩多少张以内才允许动炸弹。
 * - passTolerance：跟牌时的过牌容忍度，越高越倾向保留手牌。
 * - partnerSupport：队友领出时的让牌倾向，越高越不抢队友牌权。
 */
export interface PersonaParams {
  aggression: number;
  bombThreshold: number;
  passTolerance: number;
  partnerSupport: number;
}

export interface Persona {
  name: string;
  style: string;
  params: PersonaParams;
}

export const PERSONA: Record<'N' | 'E' | 'W', Persona> = {
  N: {
    name: '阿稳',
    style: '稳健配合',
    params: { aggression: 0.35, bombThreshold: 3, passTolerance: 0.65, partnerSupport: 0.9 },
  },
  E: {
    name: '老辣',
    style: '激进压制',
    params: { aggression: 0.85, bombThreshold: 5, passTolerance: 0.2, partnerSupport: 0.35 },
  },
  W: {
    name: '老成',
    style: '稳健控场',
    params: { aggression: 0.5, bombThreshold: 3, passTolerance: 0.55, partnerSupport: 0.7 },
  },
};

/** 离线对局里四个座位都用 AI 时，人类座位使用的中性人格。 */
export const NEUTRAL_PERSONA: Persona = {
  name: '中性',
  style: '均衡',
  params: { aggression: 0.5, bombThreshold: 3, passTolerance: 0.5, partnerSupport: 0.7 },
};

export function personaOf(seat: Seat): PersonaParams {
  if (seat === 'S') return NEUTRAL_PERSONA.params;
  return PERSONA[seat].params;
}

export interface DifficultyMeta {
  label: string;
  hint: string;
  /** 选次优动作的噪声比例。 */
  noise: number;
  /** 决策方式：L1 贪心、L2 一层前瞻、L3 采样搜索。 */
  search: 'none' | 'lookahead' | 'pimc';
  /** L3 搜索预算（毫秒）；超预算自动降级到 L2 结果。 */
  budgetMs: number;
  /** 叠加到人格上的过牌容忍度：低难度更保守，容易错失压牌时机。 */
  passTolerance: number;
}

export const DIFFICULTY: Record<AiDifficulty, DifficultyMeta> = {
  L1: {
    label: 'L1 入门',
    hint: '贪心出牌与随机过牌，适合新手找信心',
    noise: 0.15,
    search: 'none',
    budgetMs: 0,
    passTolerance: 0.2,
  },
  L2: {
    label: 'L2 进阶',
    hint: '结构保留 + 队友配合 + 炸弹时机，基本合理',
    noise: 0.05,
    search: 'lookahead',
    budgetMs: 0,
    passTolerance: 0.12,
  },
  L3: {
    label: 'L3 高手',
    hint: '按公开信息采样推断，会控场与配合（更耗设备性能）',
    noise: 0,
    search: 'pimc',
    budgetMs: 60,
    passTolerance: 0,
  },
};

export function normalizeDifficulty(value: unknown): AiDifficulty {
  return value === 'L1' || value === 'L3' ? value : 'L2';
}
