import { VERDICT_LABEL, type DecisionRecord, type DecisionVerdict } from './decisions';

/**
 * LLM 复盘点评的可插拔接口（规划 P3）。
 *
 * 约束：
 * - 本模块不绑定服务商、不读环境变量、不发起任何网络请求；
 * - 真实模型由调用方注入 `CommentaryProvider`（浏览器直连或自家后端均可）；
 * - 默认不注入 provider 时服务为「未启用」，复盘页保持现有本地点评；
 * - 提供给模型的上下文只来自本地决策日志（可见信息与用户自己的出牌），不包含他人手牌。
 */

export interface CommentaryInput {
  dealNo: number;
  /** 本副结果的人类可读描述，例如「双上，升 3 级」。 */
  result: string;
  decisions: DecisionRecord[];
}

export interface CommentaryRequest {
  system: string;
  user: string;
  /** 建议的输出上限，由调用方按模型能力裁剪。 */
  maxTokens: number;
}

export interface CommentaryResult {
  text: string;
  providerId: string;
}

/** 服务商返回的 token 用量，只用于本地记录与成本观察。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CommentaryProvider {
  readonly id: string;
  generate(request: CommentaryRequest): Promise<CommentaryResult>;
}

export interface CommentaryService {
  readonly enabled: boolean;
  readonly providerId: string | null;
  /** 无 provider、调用失败或输出为空时返回 null，调用方直接跳过点评。 */
  comment(input: CommentaryInput): Promise<CommentaryResult | null>;
}

const SYSTEM_PROMPT = [
  '你是掼蛋练习工具里的复盘教练，面向新手。',
  '只根据给定的决策记录点评，不推测或编造任何人的隐藏手牌。',
  '用中文，最多 3 点，每点一句话、不超过 40 字，先肯定做得好的地方，再给 1–2 条可执行的改进。',
].join('\n');

/** 建议文案本身常以「建议」开头，去掉前缀避免和「建议：」重复。 */
function actionTitle(title: string): string {
  const trimmed = title.replace(/^建议/, '').trim();
  return trimmed || '出牌';
}

function describeActual(decision: DecisionRecord): string {
  return decision.actual === 'PASS' ? '过牌' : `出 ${decision.actualCards.length} 张`;
}

function describeSuggested(decision: DecisionRecord): string {
  if (decision.suggestedAction === 'PASS') return '过牌';
  return `${actionTitle(decision.suggestedTitle)}（${decision.suggestedCards.length} 张）`;
}

const MAX_DECISIONS_IN_PROMPT = 8;

/** 把本地决策记录转成轻量提示词；高分歧义决策优先。 */
export function buildCommentaryPrompt(input: CommentaryInput): CommentaryRequest {
  const weight: Record<DecisionVerdict, number> = {
    mistake: 3,
    better: 2,
    style: 1,
    match: 0,
  };
  const picked = [...input.decisions]
    .sort((left, right) => weight[right.verdict] - weight[left.verdict])
    .slice(0, MAX_DECISIONS_IN_PROMPT)
    .sort((left, right) => left.turn - right.turn);

  const lines = picked.map((decision) => {
    const note = decision.note ? `；${decision.note}` : '';
    return `- 第 ${decision.turn} 手：实际${describeActual(decision)}；建议：${describeSuggested(decision)}；判定：${VERDICT_LABEL[decision.verdict]}${note}`;
  });

  const user = [
    `本副：第 ${input.dealNo} 副，结果：${input.result}。`,
    lines.length > 0 ? `关键决策：\n${lines.join('\n')}` : '本副没有与建议不一致的关键决策。',
    '请给出复盘点评。',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user, maxTokens: 300 };
}

export function createCommentaryService(
  provider?: CommentaryProvider | null,
): CommentaryService {
  const active = provider ?? null;
  return {
    enabled: active !== null,
    providerId: active?.id ?? null,
    async comment(input: CommentaryInput): Promise<CommentaryResult | null> {
      if (!active) return null;
      try {
        const result = await active.generate(buildCommentaryPrompt(input));
        const text = result.text.trim();
        if (!text) return null;
        return { text: text.slice(0, 600), providerId: active.id };
      } catch {
        // 点评是增强项：provider 失败绝不能影响复盘页。
        return null;
      }
    },
  };
}
