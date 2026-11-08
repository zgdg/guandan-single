interface Props {
  open: boolean;
  onClose: () => void;
}

const SECTIONS = [
  {
    title: '牌力与级牌',
    items: [
      '大王 > 小王 > 级牌 > A > K > Q > J > 10 … 2。',
      '级牌在单张、对子、三同张、三带对、炸弹中提升到 A 之上。',
      '红桃级牌是「逢人配」，可替代除王以外的任意牌，最多 2 张。',
    ],
  },
  {
    title: '常用牌型',
    items: [
      '单张、对子、三同张、三带对（三张 + 一对）。',
      '顺子：5 张连续单牌，A 可作 1（A2345）或 14（10JQKA），不能绕圈。',
      '三连对：3 个连续对子（6 张）；钢板：2 个连续三同张（6 张）。',
      '炸弹：4–10 张同点；四大天王：两大王 + 两小王。',
      '同花顺：5 张同花色连续牌，属炸弹类。',
    ],
  },
  {
    title: '炸弹层级',
    items: [
      '四大天王 > 6 张及以上炸弹 > 同花顺 > 5 张炸弹 > 4 张炸弹 > 普通牌型。',
      '同张数炸弹比牌点；同花顺比最高牌点，默认不比花色。',
      '逢人配可以补同花顺和炸弹，但不能补四大天王。',
    ],
  },
  {
    title: '出牌流程',
    items: [
      '领出者必须出牌；跟牌可以过牌。',
      '一圈内其余三家都过牌后，最后出牌者领出下一圈。',
      '最后出牌者已经出完时，由搭档「接风」领出。',
      '一名玩家出完即为头游；第三名出完时本副结束。',
    ],
  },
  {
    title: '进贡与升级',
    items: [
      '第 2 副起，末游向头游进贡最大的非红桃级牌；头游还一张 ≤10 的牌（默认不能还级牌）。',
      '双贡：两名下游各进最大牌，大贡给头游、小贡给二游。',
      '单贡本人两张大王、或双贡合计两张大王可抗贡，抗贡后头游领出。',
      '双下 +3 级；头游 + 三游 +2 级；头游 + 末游 +1 级；只有头游方升级。',
      '打 A 时头游方拿头游且搭档不是末游即过 A；打 A 失败默认继续打 A。',
    ],
  },
  {
    title: '练习场约定',
    items: [
      '你固定坐南家，北家是队友，东/西家是对手。',
      '建议只基于你可见的信息（自己的手牌 + 桌面公开信息），不是上帝视角。',
      '本练习场采用「全程精确展示 + 剩余 10 张提示」，不做线下报牌限制。',
    ],
  },
];

export function RulesModal({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onClose} role="presentation">
      <div className="modal rules-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>规则速查</h2>
          <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="rules-body">
          {SECTIONS.map((section) => (
            <section key={section.title} className="rules-section">
              <h3>{section.title}</h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="modal-foot">
          <span>规则口径：默认竞赛规则，可在配置中切换变体。</span>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
