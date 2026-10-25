import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { SuikaGame } from './game/SuikaGame';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH, STAGES, type GameMode } from './game/config';

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<SuikaGame | null>(null);

  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [nextStage, setNextStage] = useState(0);
  const [isGameOver, setIsGameOver] = useState(false);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<GameMode>('normal');
  const [wind, setWind] = useState({ active: false, direction: 0 });
  const [bgmOn, setBgmOn] = useState(true);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const bgmOnRef = useRef(true);

  useEffect(() => {
    const audio = new Audio('/assets/bgm.mp3');
    audio.loop = true;
    audio.volume = 0.4;
    bgmRef.current = audio;

    // ブラウザの自動再生制限対策: 再生できなければ最初のユーザー操作時に開始する
    audio.play().catch(() => {
      const startOnGesture = () => {
        if (bgmOnRef.current) {
          audio.play().catch(() => {});
        }
      };
      window.addEventListener('pointerdown', startOnGesture, { once: true });
    });

    return () => {
      audio.pause();
    };
  }, []);

  const toggleBgm = () => {
    const audio = bgmRef.current;
    if (!audio) return;
    setBgmOn((prev) => {
      const next = !prev;
      bgmOnRef.current = next;
      if (next) {
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
      return next;
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const game = new SuikaGame(canvas);
    gameRef.current = game;
    if (import.meta.env.DEV) {
      (window as any).__game = game;
    }
    game.callbacks = {
      onScoreChange: (s, hs) => {
        setScore(s);
        setHighScore(hs);
      },
      onGameOver: (s, hs) => {
        setScore(s);
        setHighScore(hs);
        setIsGameOver(true);
      },
      onNextStageChange: (idx) => setNextStage(idx),
      onWindChange: (active, direction) => setWind({ active, direction }),
    };

    game.init().then(() => {
      setHighScore(game.highScore);
      setNextStage(game.getNextStageIndex());
      setReady(true);
      game.start();
    });

    return () => {
      game.destroy();
    };
  }, []);

  const pointerToLogicalX = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return LOGICAL_WIDTH / 2;
    const rect = canvas.getBoundingClientRect();
    const ratio = LOGICAL_WIDTH / rect.width;
    return (clientX - rect.left) * ratio;
  }, []);

  const handleMove = useCallback(
    (clientX: number) => {
      gameRef.current?.setPointerX(pointerToLogicalX(clientX));
    },
    [pointerToLogicalX],
  );

  const handleDrop = useCallback(() => {
    gameRef.current?.drop();
  }, []);

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    handleMove(e.clientX);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    handleMove(e.clientX);
  };

  const handlePointerUp = () => {
    handleDrop();
  };

  const handleRestart = () => {
    gameRef.current?.restart();
    setIsGameOver(false);
  };

  const handleModeChange = (nextMode: GameMode) => {
    gameRef.current?.setMode(nextMode);
    setMode(nextMode);
    setWind({ active: false, direction: 0 });
  };

  const nextStageConfig = STAGES[nextStage];

  return (
    <main className="app-shell">
      <section className="panel">
        <header className="header">
          <h1>ジローのスイカ</h1>
          <button
            type="button"
            className={`bgm-toggle${bgmOn ? ' is-on' : ''}`}
            onClick={toggleBgm}
            aria-pressed={bgmOn}
            title={bgmOn ? 'BGMをミュート' : 'BGMを再生'}
          >
            {bgmOn ? '🔊 BGM ON' : '🔇 BGM OFF'}
          </button>
        </header>
        <div className="mode-switch" role="group" aria-label="ゲームモード">
          <button
            type="button"
            className={mode === 'normal' ? 'mode-button active' : 'mode-button'}
            onClick={() => handleModeChange('normal')}
            aria-pressed={mode === 'normal'}
          >
            ノーマル
          </button>
          <button
            type="button"
            className={mode === 'aggressive' ? 'mode-button aggressive active' : 'mode-button aggressive'}
            onClick={() => handleModeChange('aggressive')}
            aria-pressed={mode === 'aggressive'}
          >
            アグレッシブ
          </button>
        </div>
        <p className="mode-description">
          {mode === 'normal'
            ? 'じっくり考えて合体させよう'
            : '高速・高反発！ときどき吹く横風に注意'}
        </p>

        <div className="hud">
          <div className="hud-box">
            <span className="hud-label">SCORE</span>
            <span className="hud-value">{score}</span>
          </div>
          <div className="hud-box next-box">
            <span className="hud-label">NEXT</span>
            <div
              className="next-thumb"
              aria-hidden="true"
              style={{ borderColor: nextStageConfig.colorB }}
            >
              <img
                src={nextStageConfig.image}
                alt=""
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          </div>
          <div className="hud-box">
            <span className="hud-label">BEST</span>
            <span className="hud-value">{highScore}</span>
          </div>
        </div>

        <div
          className="game-container"
          style={{ aspectRatio: `${LOGICAL_WIDTH} / ${LOGICAL_HEIGHT}` }}
        >
          <canvas
            ref={canvasRef}
            className="game-canvas"
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
          />
          {wind.active && (
            <div className={`wind-banner ${wind.direction < 0 ? 'wind-left' : 'wind-right'}`}>
              {wind.direction < 0 ? '← 左から突風！' : '右から突風！ →'}
            </div>
          )}
          {!ready && <div className="loading-overlay">読み込み中...</div>}
          {isGameOver && (
            <div className="gameover-overlay">
              <h2>GAME OVER</h2>
              <p>スコア: {score}</p>
              <p>ハイスコア: {highScore}</p>
              <button type="button" onClick={handleRestart}>
                もう一度プレイ
              </button>
            </div>
          )}
        </div>

        <p className="hint">
          マウス移動 / スワイプで位置を決め、クリック・タップで落とそう。同じジローを合体させて最終段階を目指せ！
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
