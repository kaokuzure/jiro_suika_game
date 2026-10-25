// ジローのスイカゲーム: ステージ設定
// ここで全11段階の画像・表示サイズ・色を一元管理する。
// 「段階が上がるほど表示サイズが必ず大きくなる」ことを保証するため、
// 配列は radius が単調増加する前提で記述すること（起動時にチェックされる）。

export interface StageConfig {
  /** 0-indexed stage number (0 = jiro_1, 10 = jiro_11) */
  index: number;
  /** 画像パス */
  image: string;
  /** 表示半径(px) / 物理ボディの半径としても使用する */
  radius: number;
  /** 画像が読み込めない場合の仮表示用カラー */
  fallbackColor: string;
  /** 段階識別用グラデーション色(開始) */
  colorA: string;
  /** 段階識別用グラデーション色(終了) */
  colorB: string;
  /** ラベル */
  label: string;
}

// 表示直径の例（企画書 4.3 の表に基づく）。半径に変換して保持する。
const DIAMETERS = [28, 36, 45, 55, 66, 78, 91, 105, 120, 137, 155];

const FALLBACK_COLORS = [
  '#fbbf24',
  '#fb923c',
  '#f87171',
  '#f472b6',
  '#e879f9',
  '#c084fc',
  '#a78bfa',
  '#818cf8',
  '#60a5fa',
  '#38bdf8',
  '#34d399',
];

// 段階ごとのグラデーション色(暖色→寒色へ遷移して区別しやすくする)
const GRADIENT_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['#fef08a', '#facc15'],
  ['#fed7aa', '#fb923c'],
  ['#fecaca', '#f87171'],
  ['#fbcfe8', '#fb7185'],
  ['#f5d0fe', '#e879f9'],
  ['#e9d5ff', '#c084fc'],
  ['#ddd6fe', '#a78bfa'],
  ['#c7d2fe', '#818cf8'],
  ['#bfdbfe', '#60a5fa'],
  ['#bae6fd', '#38bdf8'],
  ['#a7f3d0', '#34d399'],
];

export const STAGE_COUNT = 11;

export const STAGES: StageConfig[] = Array.from({ length: STAGE_COUNT }, (_, i) => ({
  index: i,
  image: `/assets/jiro/jiro_${i + 1}.png`,
  radius: DIAMETERS[i] / 2,
  fallbackColor: FALLBACK_COLORS[i],
  colorA: GRADIENT_COLORS[i][0],
  colorB: GRADIENT_COLORS[i][1],
  label: `${i + 1}`,
}));

// 安全チェック: 段階が上がるごとに半径が単調増加していること。
(function assertMonotonicRadius() {
  for (let i = 1; i < STAGES.length; i += 1) {
    if (STAGES[i].radius <= STAGES[i - 1].radius) {
      throw new Error(
        `Stage radius must strictly increase: stage ${i} (${STAGES[i].radius}) <= stage ${i - 1} (${STAGES[i - 1].radius})`,
      );
    }
  }
})();

export const MAX_STAGE_INDEX = STAGE_COUNT - 1;

export type GameMode = 'normal' | 'aggressive';

export const MODE_SETTINGS: Record<
  GameMode,
  {
    gravityY: number;
    restitution: number;
    maxSpawnStage: number;
    dropCooldownMs: number;
    maxSpeed: number;
  }
> = {
  normal: {
    gravityY: 1.1,
    restitution: 0.34,
    maxSpawnStage: 4,
    dropCooldownMs: 350,
    maxSpeed: 26,
  },
  aggressive: {
    gravityY: 1.55,
    restitution: 0.48,
    maxSpawnStage: 4,
    dropCooldownMs: 230,
    maxSpeed: 34,
  },
};

export const AGGRESSIVE_WIND = {
  intervalMinMs: 6500,
  intervalMaxMs: 9500,
  durationMinMs: 1100,
  durationMaxMs: 1700,
  gravityX: 0.5,
  /** 突風開始時に静止中のジローへ与える水平初速(小さいジローほど大きく飛ぶ) */
  impulseBase: 5.2,
};

/** 論理ゲーム空間のサイズ（物理演算・描画の基準座標） */
export const LOGICAL_WIDTH = 320;
export const LOGICAL_HEIGHT = 480;
export const WALL_THICKNESS = 10;
/** 物理壁の外部への伸び(可視壁の内面に合わせて外側に厚く張り、貫通を防ぐ) */
export const PHYSICS_WALL_EXTENT = 60;

/** 容器の上端判定ライン(あふれ検知) */
export const DANGER_LINE_Y = 70;
/** あふれ状態が何ms続いたらゲームオーバーにするか */
export const OVER_TIME_LIMIT_MS = 2000;

/** 次のジローを落とすまでのクールダウン(ms) */
export const DROP_COOLDOWN_MS = 350;

/** 合体時のスコア: 生成される新しい段階の三角数 (段階が高いほど得点が大きい) */
export function mergeScore(newStageIndex: number): number {
  const n = newStageIndex + 1;
  return (n * (n + 1)) / 2;
}

/** 最終段階どうしの合体時の追加ボーナス */
export const FINAL_STAGE_BONUS = mergeScore(MAX_STAGE_INDEX) * 2;

export const HIGH_SCORE_KEY = 'jiro-suika-high-score';
