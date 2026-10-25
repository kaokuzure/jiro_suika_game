import Matter from 'matter-js';
import {
  AGGRESSIVE_WIND,
  DANGER_LINE_Y,
  FINAL_STAGE_BONUS,
  GameMode,
  HIGH_SCORE_KEY,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  MAX_STAGE_INDEX,
  MODE_SETTINGS,
  OVER_TIME_LIMIT_MS,
  PHYSICS_WALL_EXTENT,
  STAGES,
  WALL_THICKNESS,
  mergeScore,
} from './config';

interface FruitBody extends Matter.Body {
  plugin: {
    stageIndex: number;
    isDropping: boolean;
    popStartedAt: number | null;
    merging?: boolean;
  };
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  radius: number;
  color: string;
  /** 突風エフェクト用の流線パーティクルかどうか */
  streak?: boolean;
}

/** 画像の不透過部分の境界(box) */
interface ImageTrim {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GameCallbacks {
  onScoreChange?: (score: number, highScore: number) => void;
  onGameOver?: (score: number, highScore: number) => void;
  onNextStageChange?: (stageIndex: number) => void;
  onWindChange?: (active: boolean, direction: number) => void;
}

const POP_DURATION_MS = 220;
const POP_START_SCALE = 1.35;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 画像の透過余白をスキャンして、不透過部分の境界を求める */
function computeTrim(img: HTMLImageElement): ImageTrim | null {
  const maxDim = 256;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  let x1 = w;
  let y1 = h;
  let x2 = 0;
  let y2 = 0;
  let found = false;
  for (let yy = 0; yy < h; yy += 1) {
    for (let xx = 0; xx < w; xx += 1) {
      if (data[(yy * w + xx) * 4 + 3] > 8) {
        found = true;
        if (xx < x1) x1 = xx;
        if (yy < y1) y1 = yy;
        if (xx + 1 > x2) x2 = xx + 1;
        if (yy + 1 > y2) y2 = yy + 1;
      }
    }
  }
  if (!found) return null;
  return { x1: x1 / scale, y1: y1 / scale, x2: x2 / scale, y2: y2 / scale };
}

export class SuikaGame {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private engine: Matter.Engine;
  private world: Matter.World;
  private images: (HTMLImageElement | null)[] = [];
  private imageTrims: (ImageTrim | null)[] = [];
  private backgroundImage: HTMLImageElement | null = null;
  private aggressiveBackgroundImage: HTMLImageElement | null = null;
  private particles: Particle[] = [];
  private audioCtx: AudioContext | null = null;
  private mergeBuffer: AudioBuffer | null = null;
  private rafId: number | null = null;
  private lastTime = 0;
  private overTimer = 0;
  private shakeTime = 0;
  private shakeMagnitude = 0;

  private pointerX = LOGICAL_WIDTH / 2;
  /** 現在狙っている(次に落とす)ジロー */
  private nextStageIndex = 0;
  /** その次に来るジロー(NEXT表示用) */
  private upcomingStageIndex: number | null = null;
  /** 狙い中ジローの初期角度。アグレッシブモードではランダムに傾く */
  private spawnAngle = 0;
  private dropCooldownUntil = 0;
  private running = false;
  private gameOver = false;
  private mode: GameMode = 'normal';
  private windTimer = 0;
  private windRemaining = 0;
  private windDirection = 0;

  score = 0;
  highScore = 0;

  callbacks: GameCallbacks = {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    this.ctx = ctx;
    canvas.width = LOGICAL_WIDTH;
    canvas.height = LOGICAL_HEIGHT;

    this.engine = Matter.Engine.create();
    this.engine.gravity.y = 1.1;
    // 押し出し精度を上げ、底部での貫通・弾き出しを抑制する
    this.engine.positionIterations = 12;
    this.engine.velocityIterations = 8;
    this.world = this.engine.world;

    this.highScore = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0) || 0;

    this.buildWalls();
    this.bindCollisions();
  }

  async init() {
    this.images = await Promise.all(STAGES.map((s) => loadImage(s.image)));
    this.imageTrims = this.images.map((img) => (img ? computeTrim(img) : null));
    this.backgroundImage = await loadImage('/assets/jar-background.png');
    this.aggressiveBackgroundImage = await loadImage('/assets/jar-background-aggressive.png');
    await this.loadMergeSound();
    this.windTimer = this.randomWindInterval();
    this.pickNextStage();
  }

  /** 合体時の効果音を事前に読み込む(連続再生に耐えるよう AudioContext を使う) */
  private async loadMergeSound() {
    try {
      const AudioCtx = window.AudioContext;
      if (!AudioCtx) return;
      const res = await fetch('/assets/se_zen.aac');
      const arrayBuffer = await res.arrayBuffer();
      this.audioCtx = new AudioCtx();
      this.mergeBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    } catch {
      this.audioCtx = null;
      this.mergeBuffer = null;
    }
  }

  private playMergeSound() {
    if (!this.audioCtx || !this.mergeBuffer) return;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    try {
      const source = this.audioCtx.createBufferSource();
      source.buffer = this.mergeBuffer;
      const gain = this.audioCtx.createGain();
      gain.gain.value = 0.55;
      source.connect(gain);
      gain.connect(this.audioCtx.destination);
      source.start();
    } catch {
      // 音声再生に失敗してもゲームは継続する
    }
  }

  private randomWindInterval() {
    return AGGRESSIVE_WIND.intervalMinMs +
      Math.random() * (AGGRESSIVE_WIND.intervalMaxMs - AGGRESSIVE_WIND.intervalMinMs);
  }

  getMode() {
    return this.mode;
  }

  setMode(mode: GameMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    const settings = MODE_SETTINGS[mode];
    this.engine.gravity.y = settings.gravityY;
    this.windRemaining = 0;
    this.windDirection = 0;
    this.engine.gravity.x = 0;
    this.windTimer = this.randomWindInterval();
    this.callbacks.onWindChange?.(false, 0);
    // 狙い中・NEXTのジローは引き継ぐ(切替で引き直すと意図的な変更ができてしまうため)
  }

  private updateWind(dt: number) {
    if (this.mode !== 'aggressive' || this.gameOver) {
      this.engine.gravity.x = 0;
      return;
    }
    if (this.windRemaining > 0) {
      this.windRemaining -= dt;
      this.engine.gravity.x = this.windDirection * AGGRESSIVE_WIND.gravityX;
      this.spawnWindStreaks();
      if (this.windRemaining <= 0) {
        this.windRemaining = 0;
        this.windDirection = 0;
        this.engine.gravity.x = 0;
        this.callbacks.onWindChange?.(false, 0);
      }
      return;
    }
    this.windTimer -= dt;
    this.engine.gravity.x = 0;
    if (this.windTimer <= 0) {
      this.windDirection = Math.random() < 0.5 ? -1 : 1;
      this.windRemaining = AGGRESSIVE_WIND.durationMinMs +
        Math.random() * (AGGRESSIVE_WIND.durationMaxMs - AGGRESSIVE_WIND.durationMinMs);
      this.windTimer = this.randomWindInterval();
      this.engine.gravity.x = this.windDirection * AGGRESSIVE_WIND.gravityX;
      this.applyWindImpulse();
      this.triggerShake(5, 320);
      this.callbacks.onWindChange?.(true, this.windDirection);
    }
  }

  /** 突風開始時: 容器内のジローに水平初速を与えて一斉に流される感触を出す */
  private applyWindImpulse() {
    const bodies = Matter.Composite.allBodies(this.world) as FruitBody[];
    for (const body of bodies) {
      if (body.label !== 'fruit' || !body.plugin) continue;
      const radius = STAGES[body.plugin.stageIndex].radius;
      // 小さいジローほど軽くて大きく流される
      const impulse = AGGRESSIVE_WIND.impulseBase * Math.min(1.6, Math.max(0.5, 24 / radius));
      Matter.Body.setVelocity(body, {
        x: body.velocity.x + this.windDirection * impulse,
        y: body.velocity.y - Math.abs(impulse) * 0.25,
      });
    }
  }

  /** 突風中: 風向きに流れる水色の流線を発生させる */
  private spawnWindStreaks() {
    if (Math.random() > 0.28) return;
    const fromLeft = this.windDirection > 0;
    this.particles.push({
      x: fromLeft
        ? WALL_THICKNESS + Math.random() * 30
        : LOGICAL_WIDTH - WALL_THICKNESS - Math.random() * 30,
      y: WALL_THICKNESS + Math.random() * (LOGICAL_HEIGHT - WALL_THICKNESS * 2),
      vx: this.windDirection * (9 + Math.random() * 6),
      vy: (Math.random() - 0.5) * 0.6,
      life: 1,
      maxLife: 1,
      radius: 2 + Math.random() * 1.5,
      color: '#38bdf8',
      streak: true,
    });
  }

  private buildWalls() {
    const opts: Matter.IChamferableBodyDefinition = {
      isStatic: true,
      friction: 0.2,
      restitution: 0.1,
      label: 'wall',
    };
    // 可視壁(10px)の内面に合わせて、物理壁を外側に厚く配置し貫通を防ぐ
    const ext = PHYSICS_WALL_EXTENT;
    const ground = Matter.Bodies.rectangle(
      LOGICAL_WIDTH / 2,
      LOGICAL_HEIGHT - WALL_THICKNESS + ext / 2,
      LOGICAL_WIDTH + ext * 2,
      ext,
      opts,
    );
    const left = Matter.Bodies.rectangle(
      WALL_THICKNESS - ext / 2,
      LOGICAL_HEIGHT / 2,
      ext,
      LOGICAL_HEIGHT + ext * 2,
      opts,
    );
    const right = Matter.Bodies.rectangle(
      LOGICAL_WIDTH - WALL_THICKNESS + ext / 2,
      LOGICAL_HEIGHT / 2,
      ext,
      LOGICAL_HEIGHT + ext * 2,
      opts,
    );
    Matter.World.add(this.world, [ground, left, right]);
  }

  private bindCollisions() {
    Matter.Events.on(this.engine, 'collisionStart', (event) => {
      const mergeCandidates: { a: FruitBody; b: FruitBody }[] = [];
      const touchedFruit = new Set<number>();

      for (const pair of event.pairs) {
        const a = pair.bodyA as FruitBody;
        const b = pair.bodyB as FruitBody;
        const aFruit = a.label === 'fruit';
        const bFruit = b.label === 'fruit';

        if (aFruit && a.plugin) a.plugin.isDropping = false;
        if (bFruit && b.plugin) b.plugin.isDropping = false;

        if (aFruit && bFruit && a.plugin && b.plugin) {
          if (
            a.plugin.stageIndex === b.plugin.stageIndex &&
            !a.plugin.merging &&
            !b.plugin.merging &&
            !touchedFruit.has(a.id) &&
            !touchedFruit.has(b.id)
          ) {
            a.plugin.merging = true;
            b.plugin.merging = true;
            touchedFruit.add(a.id);
            touchedFruit.add(b.id);
            mergeCandidates.push({ a, b });
          }
        }
      }

      for (const { a, b } of mergeCandidates) {
        this.mergeBodies(a, b);
      }
    });
  }

  private mergeBodies(a: FruitBody, b: FruitBody) {
    const stageIndex = a.plugin.stageIndex;
    const x = (a.position.x + b.position.x) / 2;
    const y = (a.position.y + b.position.y) / 2;
    const avgVx = (a.velocity.x + b.velocity.x) / 2;
    const avgVy = (a.velocity.y + b.velocity.y) / 2;

    Matter.World.remove(this.world, a);
    Matter.World.remove(this.world, b);

    const stageColor = STAGES[stageIndex].colorB;
    this.spawnParticles(x, y, stageColor);
    this.triggerShake();
    this.playMergeSound();

    if (stageIndex >= MAX_STAGE_INDEX) {
      // 最終段階同士の合体: 新しい段階は無いのでボーナス得点のみ
      this.addScore(FINAL_STAGE_BONUS);
      return;
    }

    const newStageIndex = stageIndex + 1;
    const newBody = this.createFruitBody(newStageIndex, x, y);
    Matter.Body.setVelocity(newBody, { x: avgVx * 0.4, y: avgVy * 0.4 });
    (newBody as FruitBody).plugin.popStartedAt = performance.now();
    Matter.World.add(this.world, newBody);

    this.addScore(mergeScore(newStageIndex));
  }

  private addScore(points: number) {
    this.score += points;
    if (this.score > this.highScore) {
      this.highScore = this.score;
    }
    this.callbacks.onScoreChange?.(this.score, this.highScore);
  }

  private spawnParticles(x: number, y: number, color: string) {
    const count = 14;
    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const speed = 1.5 + Math.random() * 2.5;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        maxLife: 1,
        radius: 2 + Math.random() * 2.5,
        color,
      });
    }
  }

  private triggerShake(magnitude = 2.5, durationMs = 140) {
    this.shakeTime = durationMs;
    this.shakeMagnitude = magnitude;
  }

  private createFruitBody(stageIndex: number, x: number, y: number): FruitBody {
    const stage = STAGES[stageIndex];
    // スポーン位置を必ず容器内側にクランプし、床や壁と重なって
    // 物理エンジンの押し出しで容器外へ弾き出されるのを防ぐ
    const minX = WALL_THICKNESS + stage.radius;
    const maxX = LOGICAL_WIDTH - WALL_THICKNESS - stage.radius;
    const minY = WALL_THICKNESS + stage.radius;
    const maxY = LOGICAL_HEIGHT - WALL_THICKNESS - stage.radius;
    const cx = Math.min(maxX, Math.max(minX, x));
    const cy = Math.min(maxY, Math.max(minY, y));
    const settings = MODE_SETTINGS[this.mode];
    const body = Matter.Bodies.circle(cx, cy, stage.radius, {
      restitution: settings.restitution,
      friction: 0.3,
      frictionAir: 0.001,
      density: 0.0015,
      label: 'fruit',
    }) as FruitBody;
    body.plugin = {
      stageIndex,
      isDropping: true,
      popStartedAt: null,
    };
    return body;
  }

  private pickNextStage() {
    const roll = () => {
      const maximum = MODE_SETTINGS[this.mode].maxSpawnStage;
      return Math.floor(Math.random() * (maximum + 1));
    };
    // 「次の次」を繰り上げて新しい狙いにし、次の「次の次」を補充する
    this.nextStageIndex = this.upcomingStageIndex ?? roll();
    this.upcomingStageIndex = roll();
    // アグレッシブモードでは狙い中のジローがランダムに傾く(±0.45ラジアン程度)
    this.spawnAngle = this.mode === 'aggressive' ? (Math.random() - 0.5) * 0.9 : 0;
    const radius = STAGES[this.nextStageIndex].radius;
    this.pointerX = Math.max(
      WALL_THICKNESS + radius,
      Math.min(LOGICAL_WIDTH - WALL_THICKNESS - radius, this.pointerX),
    );
    this.callbacks.onNextStageChange?.(this.upcomingStageIndex);
  }

  setPointerX(logicalX: number) {
    const radius = STAGES[this.nextStageIndex].radius;
    const min = WALL_THICKNESS + radius;
    const max = LOGICAL_WIDTH - WALL_THICKNESS - radius;
    this.pointerX = Math.min(max, Math.max(min, logicalX));
  }

  getPointerX() {
    return this.pointerX;
  }

  getNextStageIndex() {
    // NEXT表示は「次に来るジロー」を返す(狙い中のジローではない)
    return this.upcomingStageIndex ?? this.nextStageIndex;
  }

  // ---- 開発・検証用ヘルパー(本編のロジックには影響しない) ----

  debugSpawnStage(stageIndex: number, x: number, y: number) {
    const body = this.createFruitBody(stageIndex, x, y);
    body.plugin.isDropping = false;
    Matter.World.add(this.world, body);
    return body.id;
  }

  debugBodies() {
    return Matter.Composite.allBodies(this.world).map((b) => ({
      id: b.id,
      label: b.label,
      x: Math.round(b.position.x * 10) / 10,
      y: Math.round(b.position.y * 10) / 10,
      stage: (b as FruitBody).plugin?.stageIndex,
      speed: Math.round(b.speed * 100) / 100,
    }));
  }

  canDrop() {
    return !this.gameOver && performance.now() >= this.dropCooldownUntil;
  }

  drop() {
    if (!this.canDrop()) return;
    const stageIndex = this.nextStageIndex;
    const stage = STAGES[stageIndex];
    const spawnY = DANGER_LINE_Y - stage.radius - 4;
    const body = this.createFruitBody(stageIndex, this.pointerX, Math.max(stage.radius + 2, spawnY));
    // アグレッシブモードでは狙い中に表示されていた傾きのまま落とす
    Matter.Body.setAngle(body, this.spawnAngle);
    Matter.World.add(this.world, body);
    this.dropCooldownUntil = performance.now() + MODE_SETTINGS[this.mode].dropCooldownMs;
    this.pickNextStage();
  }

  /** 速度の上限クランプと、容器外へ脱出したボディのフェイルセーフ除去 */
  private constrainBodies() {
    const bodies = Matter.Composite.allBodies(this.world) as FruitBody[];
    const maxSpeed = MODE_SETTINGS[this.mode].maxSpeed;
    const escaped: Matter.Body[] = [];
    for (const body of bodies) {
      if (body.label !== 'fruit' || !body.plugin) continue;
      if (body.speed > maxSpeed) {
        const factor = maxSpeed / body.speed;
        Matter.Body.setVelocity(body, {
          x: body.velocity.x * factor,
          y: body.velocity.y * factor,
        });
      }
      const radius = STAGES[body.plugin.stageIndex].radius;
      if (
        body.position.x < WALL_THICKNESS - radius - 40 ||
        body.position.x > LOGICAL_WIDTH - WALL_THICKNESS + radius + 40 ||
        body.position.y - radius > LOGICAL_HEIGHT + 40
      ) {
        escaped.push(body);
      }
    }
    if (escaped.length > 0) {
      Matter.World.remove(this.world, escaped);
    }
  }

  private checkGameOver(dt: number) {
    if (this.gameOver) return;
    const bodies = Matter.Composite.allBodies(this.world) as FruitBody[];
    let violating = false;
    for (const body of bodies) {
      if (body.label !== 'fruit' || !body.plugin) continue;
      if (body.plugin.isDropping) continue;
      const radius = STAGES[body.plugin.stageIndex].radius;
      if (body.position.y - radius < DANGER_LINE_Y) {
        violating = true;
        break;
      }
    }
    if (violating) {
      this.overTimer += dt;
      if (this.overTimer >= OVER_TIME_LIMIT_MS) {
        this.triggerGameOver();
      }
    } else {
      this.overTimer = 0;
    }
  }

  private triggerGameOver() {
    this.gameOver = true;
    if (this.score > this.highScore) {
      this.highScore = this.score;
    }
    localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
    this.callbacks.onGameOver?.(this.score, this.highScore);
  }

  isGameOver() {
    return this.gameOver;
  }

  restart() {
    const bodies = Matter.Composite.allBodies(this.world).filter((b) => b.label === 'fruit');
    Matter.World.remove(this.world, bodies);
    this.particles = [];
    this.score = 0;
    this.overTimer = 0;
    this.gameOver = false;
    this.dropCooldownUntil = 0;
    this.callbacks.onScoreChange?.(this.score, this.highScore);
    this.pickNextStage();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (time: number) => {
      try {
        const dt = Math.min(32, time - this.lastTime);
        this.lastTime = time;
        this.updateWind(dt);
        Matter.Engine.update(this.engine, dt);
        this.constrainBodies();
        this.updateParticles(dt);
        this.checkGameOver(dt);
        this.render();
        if (this.shakeTime > 0) this.shakeTime -= dt;
      } catch (err) {
        // 物理演算や描画で想定外の例外が起きてもループを止めず継続する
        console.error('SuikaGame loop error:', err);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private updateParticles(dt: number) {
    const decay = dt / 420;
    const streakDecay = dt / 620;
    this.particles = this.particles.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.streak) {
        // 流線は重力を受けず、画面外に出たら即消滅
        p.life -= streakDecay;
        return (
          p.life > 0 &&
          p.x > WALL_THICKNESS - 20 &&
          p.x < LOGICAL_WIDTH - WALL_THICKNESS + 20
        );
      }
      p.vy += 0.04;
      p.life -= decay;
      return p.life > 0;
    });
  }

  private render() {
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    if (this.shakeTime > 0) {
      const dx = (Math.random() - 0.5) * this.shakeMagnitude;
      const dy = (Math.random() - 0.5) * this.shakeMagnitude;
      ctx.translate(dx, dy);
    }

    // background
    ctx.fillStyle = '#fff7ed';
    ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    const backgroundImage = this.mode === 'aggressive' ? this.aggressiveBackgroundImage : this.backgroundImage;
    if (backgroundImage) {
      const availableWidth = LOGICAL_WIDTH - WALL_THICKNESS * 4;
      const availableHeight = LOGICAL_HEIGHT - WALL_THICKNESS * 2;
      const scale = Math.min(
        availableWidth / backgroundImage.width,
        availableHeight / backgroundImage.height,
      );
      const width = backgroundImage.width * scale;
      const height = backgroundImage.height * scale;
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.drawImage(
        backgroundImage,
        (LOGICAL_WIDTH - width) / 2,
        (LOGICAL_HEIGHT - height) / 2,
        width,
        height,
      );
      ctx.restore();
    }

    // danger line
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = this.overTimer > 0 ? '#ef4444' : '#fca5a5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(WALL_THICKNESS, DANGER_LINE_Y);
    ctx.lineTo(LOGICAL_WIDTH - WALL_THICKNESS, DANGER_LINE_Y);
    ctx.stroke();
    ctx.restore();

    // walls
    ctx.fillStyle = '#d97706';
    ctx.fillRect(0, LOGICAL_HEIGHT - WALL_THICKNESS, LOGICAL_WIDTH, WALL_THICKNESS);
    ctx.fillRect(0, 0, WALL_THICKNESS, LOGICAL_HEIGHT);
    ctx.fillRect(LOGICAL_WIDTH - WALL_THICKNESS, 0, WALL_THICKNESS, LOGICAL_HEIGHT);

    // fruits
    const bodies = Matter.Composite.allBodies(this.world) as FruitBody[];
    for (const body of bodies) {
      if (body.label !== 'fruit' || !body.plugin) continue;
      this.drawFruit(body);
    }

    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      if (p.streak) {
        // 突風の流線: 進行方向に短い線を引く
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.radius;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 3.2, p.y - p.vy * 3.2);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // aiming preview (only while not game over and not dropping cooldown-blocked visual)
    if (!this.gameOver) {
      this.drawPreview();
    }

    ctx.restore();
  }

  private drawPreview() {
    const ctx = this.ctx;
    const stage = STAGES[this.nextStageIndex];
    const y = Math.max(stage.radius + 2, DANGER_LINE_Y - stage.radius - 4);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#94a3b8';
    ctx.beginPath();
    ctx.moveTo(this.pointerX, y + stage.radius);
    ctx.lineTo(this.pointerX, LOGICAL_HEIGHT - WALL_THICKNESS);
    ctx.stroke();
    ctx.restore();

    this.drawJiro(this.pointerX, y, stage.radius, stage.index, this.spawnAngle, 0.9);
  }

  private drawFruit(body: FruitBody) {
    const stage = STAGES[body.plugin.stageIndex];
    let scale = 1;
    if (body.plugin.popStartedAt !== null) {
      const elapsed = performance.now() - body.plugin.popStartedAt;
      if (elapsed < POP_DURATION_MS) {
        const t = elapsed / POP_DURATION_MS;
        scale = POP_START_SCALE + (1 - POP_START_SCALE) * t;
      } else {
        body.plugin.popStartedAt = null;
      }
    }
    this.drawJiro(
      body.position.x,
      body.position.y,
      stage.radius * scale,
      stage.index,
      body.angle,
      1,
    );
  }

  private drawJiro(
    x: number,
    y: number,
    radius: number,
    stageIndex: number,
    rotation: number,
    alpha: number,
  ) {
    const ctx = this.ctx;
    const stage = STAGES[stageIndex];
    const img = this.images[stageIndex];
    const trim = this.imageTrims[stageIndex];

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rotation);

    // 画像の縦横比に合わせたグラデーション光彩で段階を区別する。
    const sourceWidth = trim ? trim.x2 - trim.x1 : img?.width ?? radius * 2;
    const sourceHeight = trim ? trim.y2 - trim.y1 : img?.height ?? radius * 2;
    const imageScale = ((radius - 2) * 2) / Math.max(sourceWidth, sourceHeight);
    const imageWidth = sourceWidth * imageScale;
    const imageHeight = sourceHeight * imageScale;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(imageWidth, imageHeight) * 0.65);
    glow.addColorStop(0, hexToRgba(stage.colorB, 0.34));
    glow.addColorStop(1, hexToRgba(stage.colorB, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(0, 0, imageWidth * 0.65, imageHeight * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();

    const tint = ctx.createLinearGradient(-imageWidth / 2, -imageHeight / 2, imageWidth / 2, imageHeight / 2);
    tint.addColorStop(0, stage.colorA);
    tint.addColorStop(1, stage.colorB);
    ctx.strokeStyle = tint;
    ctx.lineWidth = Math.max(1, radius * 0.06);
    ctx.beginPath();
    ctx.ellipse(0, 0, imageWidth / 2 + 1.5, imageHeight / 2 + 1.5, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (img && trim) {
      // 透過余白をトリミングし、画像の実在有効部分を直径に合わせて描画する。
      // 円形クリップは使わず、画像本来の形を活かす。
      const srcW = trim.x2 - trim.x1;
      const srcH = trim.y2 - trim.y1;
      const w = srcW * imageScale;
      const h = srcH * imageScale;
      ctx.drawImage(img, trim.x1, trim.y1, srcW, srcH, -w / 2, -h / 2, w, h);
    } else if (img) {
      // トリミング情報が取れない場合のフォールバック: contain 相当
      const scale = ((radius - 2) * 2) / Math.max(img.width, img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // 画像がない場合の仮素材: グラデーション円 + 段階番号
      const fill = ctx.createLinearGradient(-radius * 0.9, -radius * 0.9, radius * 0.9, radius * 0.9);
      fill.addColorStop(0, stage.colorA);
      fill.addColorStop(1, stage.colorB);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(0, 0, radius - 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(55,40,20,0.85)';
      ctx.font = `bold ${Math.max(10, radius * 0.9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.rotate(-rotation);
      ctx.fillText(stage.label, 0, 0);
    }

    ctx.restore();
  }

  destroy() {
    this.stop();
    Matter.World.clear(this.world, false);
    Matter.Engine.clear(this.engine);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
