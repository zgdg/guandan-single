import { useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { DIFFICULTY, type AiDifficulty } from '../../ai/persona';
import { RulesModal } from '../components/RulesModal';

export function HomePage() {
  const startGame = useGameStore((store) => store.startGame);
  const loadGame = useGameStore((store) => store.loadGame);
  const hasSave = useGameStore((store) => store.hasSave);
  const message = useGameStore((store) => store.message);
  const settings = useGameStore((store) => store.settings);
  const setSpeed = useGameStore((store) => store.setSpeed);
  const setAiDifficulty = useGameStore((store) => store.setAiDifficulty);
  const [rulesOpen, setRulesOpen] = useState(false);
  const difficulties: AiDifficulty[] = ['L1', 'L2', 'L3'];

  return (
    <div className="home">
      <div className="home-glow" />
      <header className="home-head">
        <div className="brand-mark">掼</div>
        <div>
          <h1>掼蛋练习场</h1>
          <p>单机陪练 · 三个 AI 陪你打 · 每一步告诉你为什么</p>
        </div>
      </header>

      <main className="home-main">
        {message && <div className="notice notice-warn">{message}</div>}

        <section className="home-hero">
          <div className="hero-copy">
            <span className="hero-kicker">P1 单机 MVP</span>
            <h2>先打完一副牌，<br />再学会怎么打。</h2>
            <p>
              你坐南家，北家是队友，东西家是对手。发牌、进贡、出牌、接风、升级全部按默认竞赛规则走，
              轮到你的每一步都会给出一个合法建议和一句理由。
            </p>
          </div>
          <div className="hero-cards" aria-hidden="true">
            <span className="hero-card hero-card-red">♥ A</span>
            <span className="hero-card">♠ K</span>
            <span className="hero-card hero-card-gold">大 王</span>
          </div>
        </section>

        <section className="home-actions">
          <button type="button" className="btn btn-primary btn-large" onClick={startGame}>
            开始练习
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-large"
            onClick={loadGame}
            disabled={!hasSave}
          >
            继续上局
          </button>
          <button type="button" className="btn btn-ghost btn-large" onClick={() => setRulesOpen(true)}>
            规则速查
          </button>
        </section>
        {!hasSave && <p className="home-hint">暂无存档。开始一局后会自动保存在本机。</p>}

        <section className="home-grid">
          <article className="feature">
            <h3>完整流程</h3>
            <p>发牌 → 进贡/还贡 → 出牌 → 接风 → 结算升级，一副牌能真正打完。</p>
          </article>
          <article className="feature">
            <h3>合法建议</h3>
            <p>只基于你可见的信息枚举合法牌型，推荐牌型高亮并附一句理由。</p>
          </article>
          <article className="feature">
            <h3>本机存档</h3>
            <p>每步自动保存；关掉页面后可以继续上局，版本不兼容会明确提示。</p>
          </article>
          <article className="feature">
            <h3>可加速</h3>
            <p>AI 行动间隔可切换 0.5× / 1× / 2×，练习连续打到过 A。</p>
          </article>
        </section>

        <section className="speed-row">
          <span>AI 速度</span>
          {[0.5, 1, 2].map((speed) => (
            <button
              key={speed}
              type="button"
              className={['speed-btn', settings.speed === speed ? 'speed-active' : ''].join(' ')}
              onClick={() => setSpeed(speed)}
            >
              {speed}×
            </button>
          ))}
        </section>

        <section className="speed-row">
          <span>AI 难度</span>
          {difficulties.map((difficulty) => (
            <button
              key={difficulty}
              type="button"
              className={[
                'speed-btn',
                settings.aiDifficulty === difficulty ? 'speed-active' : '',
              ].join(' ')}
              onClick={() => setAiDifficulty(difficulty)}
            >
              {DIFFICULTY[difficulty].label}
            </button>
          ))}
        </section>
        <p className="home-hint">{DIFFICULTY[settings.aiDifficulty].hint}</p>
      </main>

      <footer className="home-foot">
        <span>默认竞赛口径 · 规则版本 0.1.0</span>
        <span>不联网 · 不上传手牌</span>
      </footer>

      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </div>
  );
}
