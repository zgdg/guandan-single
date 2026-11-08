import { describe, expect, it } from 'vitest';
import {
  buildCommentaryPrompt,
  createCommentaryService,
  type CommentaryProvider,
  type CommentaryRequest,
} from '../../src/review/commentary';
import type { DecisionRecord } from '../../src/review/decisions';

function record(overrides: Partial<DecisionRecord> & Pick<DecisionRecord, 'turn' | 'verdict'>): DecisionRecord {
  const defaults: Omit<DecisionRecord, 'turn' | 'verdict'> = {
    id: `1-${overrides.turn}`,
    dealNo: 1,
    actual: 'PLAY',
    actualCards: [],
    suggestedAction: 'PASS',
    suggestedCards: [],
    suggestedTitle: '出对 8',
    note: '',
    snapshot: {
      handCounts: { S: 10, E: 8, N: 9, W: 12 },
      lastPlay: null,
      level: 2,
    },
  };
  return { ...defaults, ...overrides };
}

const records: DecisionRecord[] = [
  record({ turn: 1, verdict: 'match' }),
  record({ turn: 3, verdict: 'style', note: '抢了队友的领出权', suggestedTitle: '过牌' }),
  record({ turn: 5, verdict: 'mistake', note: '对手只剩 2 张，本可以拦住', suggestedTitle: '出单 A' }),
  record({ turn: 8, verdict: 'better', note: '多消耗了一个炸弹', suggestedTitle: '出对 8' }),
];

describe('LLM 复盘点评可插拔接口', () => {
  it('默认不注入 provider 时服务未启用且不产出点评', async () => {
    const service = createCommentaryService();
    expect(service.enabled).toBe(false);
    expect(service.providerId).toBeNull();
    await expect(service.comment({ dealNo: 1, result: '双上，升 3 级', decisions: records })).resolves.toBeNull();
  });

  it('提示词只使用本地决策记录，并优先放入失误', () => {
    const prompt = buildCommentaryPrompt({ dealNo: 1, result: '双上，升 3 级', decisions: records });
    expect(prompt.user).toContain('第 5 手');
    expect(prompt.user).toContain('明显失误');
    expect(prompt.user).toContain('对手只剩 2 张');
    expect(prompt.system).toContain('不推测或编造');
    // 不含任何他人手牌信息，只出现张数等公开信息。
    expect(prompt.user).not.toContain('♠');
    expect(prompt.user).not.toContain('隐藏手牌');
    expect(prompt.maxTokens).toBeGreaterThan(0);
  });

  it('注入 provider 后返回清洗后的点评，并带上 providerId', async () => {
    let received: CommentaryRequest | null = null;
    const provider: CommentaryProvider = {
      id: 'fake-provider',
      async generate(request) {
        received = request;
        return { text: '  前半段控场不错，第 5 手该拦。  ', providerId: 'fake-provider' };
      },
    };
    const service = createCommentaryService(provider);
    expect(service.enabled).toBe(true);
    const result = await service.comment({ dealNo: 1, result: '双上，升 3 级', decisions: records });
    expect(result?.text).toBe('前半段控场不错，第 5 手该拦。');
    expect(result?.providerId).toBe('fake-provider');
    expect(received).toBeTruthy();
    expect(received!.user).toContain('请给出复盘点评');
  });

  it('provider 抛错或返回空文本时静默跳过，不影响复盘页', async () => {
    const failing: CommentaryProvider = {
      id: 'failing',
      async generate() {
        throw new Error('network down');
      },
    };
    await expect(
      createCommentaryService(failing).comment({ dealNo: 1, result: '双上', decisions: records }),
    ).resolves.toBeNull();

    const empty: CommentaryProvider = {
      id: 'empty',
      async generate() {
        return { text: '   ', providerId: 'empty' };
      },
    };
    await expect(
      createCommentaryService(empty).comment({ dealNo: 1, result: '双上', decisions: records }),
    ).resolves.toBeNull();
  });
});
