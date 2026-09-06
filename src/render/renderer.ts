/**
 * three.js による見下ろしビュー。World を読んで描画するだけで、シム状態は一切変更しない。
 *
 * 正射影カメラで真下(−Y)を向く。画面軸は +X が右、+Z が下。
 * 現状は平面トークン(円盤 + 向きを示すくさび形)。将来3Dフィギュアへ差し替える際も
 * シム側には手を入れずに済む(design AD-4/AD-5)。
 */

import * as THREE from "three";
import type { World } from "@sim/world.ts";
import type { Side, Soldier, Vec2 } from "@sim/types.ts";
import type { ViewResult } from "@sim/viewpoint.ts";
import { LITTER, MORTAR, SIM_HZ, SOLDIER_RADIUS } from "@sim/constants.ts";
import { collidesWall, hasLineOfSight } from "@sim/geometry.ts";
import { coverBonus } from "@sim/cover.ts";
import { MAP } from "../theme.ts";

/**
 * レンダラへ毎フレーム渡す「いま何を強調して描くか」。ui/store の debug スライスと
 * 構造的に一致していればよい(レンダラは ui/ に依存しない)。
 */
export interface RenderOpts {
  debug: {
    fov: "off" | "selected" | "side" | "all";
    showPaths: boolean;
    showConcealment: boolean;
    showShotLines: boolean;
    showOrders: boolean;
    showContactRings: boolean;
    /** 中隊長が持っている前線(FLOT)と火力の統制線(`[v6.16]`) */
    showFlot: boolean;
  };
  /** クリック選択した兵士(デバッグ表示の基準) */
  selectedId: number | null;
  /** 人間が操作中のノードの身体(仕様 §4) */
  controlledId: number | null;
  /** いま見ている陣営 */
  viewSide: Side;
  /** 神視点か(敵も向き付きトークンで描く) */
  truth: boolean;
  /**
   * 配置エディタの計画(`[v6.4]`)。まだ戦闘へ反映されていない「予定」を薄く重ねる。
   * ui/store の DeploymentPlan と構造的に一致していればよい(レンダラは ui/ に依存しない)。
   */
  setup?: {
    spawn: Partial<Record<Side, { pos: Vec2; facing: Vec2 }>>;
    objectives: { label: string; pos: Vec2; radius: number }[] | null;
  } | null;
  /** 配置エディタで選んでいる道具。選択中の対象を強めに描く */
  setupTool?: null | "blueSpawn" | "redSpawn" | "objective";
  /**
   * 作戦立案フェーズの接近経路(`[v6.5]`)。中隊長が各小隊へ与えた接近軸を、
   * 矢印付きの折れ線として盤面に重ねる。`hovered` はパネル側でカーソルを
   * 乗せている項目のキーで、その1本だけを強調する(地図に文字を出さずに
   * パネルの行と経路を対応づけるための手段)。
   */
  planRoutes?: PlanRouteView[] | null;
  hoveredPlanKey?: string | null;
}

/** レンダラが描く接近経路1本。ui/store の PlanTask と構造的に一致していればよい。 */
export interface PlanRouteView {
  /** `${side}:${platoonId}` */
  key: string;
  side: Side;
  main: boolean;
  points: Vec2[];
}

/**
 * ── 配色と記号体系(`[v6.6]` — UIレビュー 03/04)──
 *
 * **色はここで定義しない。** `src/theme.ts` が唯一のソースで、HUDのCSSも同じ場所を
 * 読む(以前は renderer と styles.css の二重管理で、凡例が地図とずれる事故の元だった)。
 *
 * 記号の作り方は「**色相は誰か、明度と形はどうなっているか**」。意味を持つ色は5つしか
 * 無く(陣営2 + 要処置 + 操作/搬送 + 安定)、状態は色を増やさず**形**で分ける:
 *
 *   健常       陣営色のベタ塗り円 — これだけが「動ける兵」
 *   制圧       陣営色はそのまま + 外周に白リング(色を置き換えないので負傷と混ざらない)
 *   出血中     黄の抜き円(中心が空くので、ベタ塗りの健常と形で分かれる)
 *   止血済     同じ黄の抜き円 + 緑の芯(「傷は同じ、処置が済んだ」を差分で示す)
 *   担架搬送   運ぶ側 = 陣営色 + 水色の内リング / 運ばれる側 = 負傷記号 / 2点を水色線で結ぶ
 *   戦死       円をやめて暗い×(色ではなく形が変わるので引きでも読める)
 *   敵の目撃   菱形 + 破線の不確度円(実線・円の実体と描き分ける)
 *
 * 階級は円の**上**に横棒。本数と長さだけで表し、点と棒の混在をやめた。
 */
const SIDE_COLOR: Record<Side, number> = { blue: MAP.blue, red: MAP.red };

/** 影のずれ m。全ての影で共通にしないと光源が2つあるように見える */
const SHADOW_DX = 2.4;
const SHADOW_DZ = 3.2;
const SHADOW_OPACITY = 0.3;

/** 配置エディタの「予定」。実際の拠点や陣営色と必ず違う見た目にする(`[v6.4]`) */
const PLAN_COLOR = 0xf2ecdd;
/** 発砲線: 命中 / 外れ */
const TRACER_HIT_COLOR = 0xfff0a0;
const TRACER_MISS_COLOR = 0x5c5341;
/** 発砲線の寿命(秒)。短く光ってすぐ消える */
const TRACER_LIFE = 0.11;
/** 擲弾の着弾円の寿命(秒) */
const BLAST_LIFE = 0.55;
/**
 * 迫撃砲の着弾の寿命(秒)。擲弾より長い — 60mm の一発は擲弾とは別物の出来事で、
 * 目を上げて「いま何が起きた」と見に行く時間が要る(`[v6.9]`)。
 */
const MORTAR_BLAST_LIFE = 1.5;
/** 破片の飛散線の寿命(秒)。閃光より少しだけ長く残る */
const DEBRIS_LIFE = 0.7;
/** 1発あたりの破片線の本数 */
const DEBRIS_PER_BLAST = 14;
const MAX_TRACERS = 400;
const MAX_BLASTS = 24;
const MAX_DEBRIS = 240;
/** 着弾前の警告リングの最大数(同時に飛んでいる射撃任務の数) */
const MAX_INCOMING = 8;
/** 窓を描く幅 m。実際の開口(1.1m)より気持ち広く取ると遠景で消えない */
const WINDOW_DRAW_W = 1.6;
/** 指揮線の最大本数。中隊長でも小隊3+本部数名なので十分 */
const MAX_COMMAND_LINKS = 64;
/**
 * 前線の破線1本の長さ・間隔 m(`[v6.16]`、`[v6.17]` で折れ線化)。
 * 本数は中隊の線 + 小隊3本ぶんの折れ線を賄える程度に取る。
 */
const FLOT_DASHES = 260;
/** 中隊長の線。長い破線 + 両端を延ばす — 図の中で主となる1本 */
const FLOT_CO = { dash: 8, gap: 5, extend: 60 };
/** 小隊長の線。細かい破線で延長なし。中隊の線の下に敷く「解像度の細かい層」 */
const FLOT_PL = { dash: 3, gap: 4, extend: 0 };
/** 隠蔽率グリッドの1セルの1辺 m と最大セル数 */
const GRID_CELL = 2.5;
const MAX_GRID_CELLS = 6000;

interface Tracer {
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  hit: boolean;
  life: number;
}
interface Blast {
  x: number;
  z: number;
  radius: number;
  side: Side;
  life: number;
  /** 擲弾か迫撃砲か(`[v6.9]`)。寿命と層の数が変わる */
  mortar: boolean;
  /** 制圧が及ぶ半径 m。迫撃砲だけが持つ外側の土煙 */
  suppressRadius: number;
}
/** 破片の飛散線(`[v6.9]`)。着弾点から放射状に伸びて消える */
interface Debris {
  x: number;
  z: number;
  /** 進行方向(単位ベクトル)と到達長 */
  dx: number;
  dz: number;
  len: number;
  life: number;
}
const MAX_SOLDIERS = 512;
const MAX_CONTACTS = 512;

// ── トークンの寸法(すべて「円の半径 R」を基準にした比で持つ) ────────────────
/** 兵士トークンの円の半径 m */
const TOKEN_R = SOLDIER_RADIUS * 1.6;
/** 状態リング(負傷の抜き円 / 担架班の内リング)の内径・外径 = R × これ */
const BODY_RING_IN = 0.56;
const BODY_RING_OUT = 1.0;
/** 制圧の外周リング。トークンの**外**に足す */
const HALO_RING_IN = 1.12;
const HALO_RING_OUT = 1.44;
/** 戦死の×の腕の長さ・太さ = R × これ */
const KIA_ARM = 1.15;
const KIA_THICK = 0.3;

/**
 * 階級章(`[v6.6]` — UIレビュー 診断D)。点と棒の混在をやめ、**円の上の横棒**に統一した。
 * 本数と長さの2軸で4階級を表す。兵士点の外に出すので、点の状態表示と干渉しない。
 *
 *   FTリーダー 短い棒 ×1 / 分隊長 短い棒 ×2 / 小隊長 長い棒 ×2 / 中隊長 長い棒 ×3
 *
 * 階級は肩書きではなく §12 の**指揮継承の結果**(`commanderId`)から引くので、
 * 分隊長が倒れて次席が引き継げば標もそちらへ移る。
 */
const RANK_NONE = 0;
const RANK_FIRETEAM = 1;
const RANK_SQUAD = 2;
const RANK_PLATOON = 3;
const RANK_COMPANY = 4;
/** 棒の寸法 = トークンの直径 × これ */
const BAR_SHORT = 0.6;
const BAR_LONG = 0.92;
const BAR_THICK = 0.15;
const BAR_GAP = 0.13;
/** 兵士1名あたりの階級棒の上限(中隊長の3本) */
const MAX_RANK_MARKS = MAX_SOLDIERS * 3;

/**
 * 縮尺による間引き(`[v6.6]` — UIレビュー 04「縮尺による間引き」)。
 * しきい値は**トークンの直径のピクセル数**。ここ1箇所でしか判定しない。
 *
 *   near (>=6px) 階級棒・搬送線・向きのくさび・制圧リングまで全部
 *   mid  (3-6px) 階級は小隊長以上のみ。搬送線と状態リングは残す
 *   far  (<3px)  健常 / 負傷(黄) / 戦死(暗) の3段だけ。リングも棒も出さない
 *
 * 拠点標・選択リング・命令線・発砲線は縮尺によらず常に出す — 前者3つは操作の
 * 手がかりで、発砲線は「どこで戦っているか」を引きの絵で示す唯一の手段だから。
 */
type Lod = "near" | "mid" | "far";
const LOD_NEAR_PX = 6;
const LOD_MID_PX = 3;


/**
 * 選択した兵士が指揮官なら、その**指揮範囲**を返す(`[v6.4]` 4回目のテストプレイ指摘⑤)。
 *
 * 「指揮官かどうか」は肩書き(`isSquadLeader` 等)ではなく §12 の継承結果
 * (`commanderId`)から引く。分隊長が倒れて次席のFTリーダーが分隊を引き継いだ場合、
 * 彼を選べば分隊全員が強調される — 画面がそのまま指揮系統の現状を示す。
 *
 * `covers` は麾下かどうか、`directIds` は**直属の下位指揮官**の兵士id
 * (中隊長→小隊長、小隊長→分隊長、分隊長→FTリーダー)。線はこちらにだけ引く。
 */
function commandScopeOf(
  world: World,
  sel: Soldier,
): { covers: (s: Soldier) => boolean; directIds: Set<number> } | null {
  const directIds = new Set<number>();
  const sameSide = (s: Soldier): boolean => s.side === sel.side;

  const co = world.companies.find((c) => c.side === sel.side && c.commanderId === sel.id);
  if (co) {
    for (const pl of world.platoons) {
      if (pl.side === sel.side && pl.companyId === co.companyId && pl.commanderId !== null) {
        directIds.add(pl.commanderId);
      }
    }
    return { covers: (s) => sameSide(s) && s.companyId === co.companyId, directIds };
  }

  const pl = world.platoons.find((p) => p.side === sel.side && p.commanderId === sel.id);
  if (pl) {
    for (const sq of world.squads) {
      if (sq.side === sel.side && sq.platoonId === pl.platoonId && sq.commanderId !== null) {
        directIds.add(sq.commanderId);
      }
    }
    return { covers: (s) => sameSide(s) && s.platoonId === pl.platoonId, directIds };
  }

  const sq = world.squads.find((q) => q.side === sel.side && q.commanderId === sel.id);
  if (sq) {
    for (const s of world.soldiers) {
      if (
        s.side === sel.side &&
        s.squadId === sq.squadId &&
        s.isFireteamLeader &&
        s.status === "ok"
      ) {
        directIds.add(s.id);
      }
    }
    return { covers: (s) => sameSide(s) && s.squadId === sq.squadId, directIds };
  }

  // FTリーダー(分隊長を継承していない場合)。麾下は自分のファイアチーム
  if (sel.isFireteamLeader && sel.fireteamId >= 0) {
    return {
      covers: (s) =>
        sameSide(s) && s.squadId === sel.squadId && s.fireteamId === sel.fireteamId,
      directIds,
    };
  }
  return null;
}
/**
 * 砂地のテクスチャを手続き的に作る(`[v6.5]`)。
 *
 * 外部アセットを持ち込まない方針(design AD-4/AD-5)なので、canvas に描いて
 * そのまま貼る。単色の平面は「地面」ではなく「背景」に見えてしまい、部隊が
 * どれだけ進んだのかが読み取れない — 色むらがあるだけでスケール感が出る。
 *
 * 種を固定しているのは、再読み込みのたびに地面の模様が変わると「同じ盤面」に
 * 見えなくなるため(シムの決定性とは無関係。ここはレンダラの都合)。
 */
function makeGroundTexture(): THREE.CanvasTexture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#9c8763";
  g.fillRect(0, 0, S, S);
  let seed = 0x2f6b3c1d;
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // 乾いた土の色むら(踏み固められた地面と砂だまり)。
  // 濃い斑をわずかに散らす程度に留める — 強くすると雲が浮いているように見え、
  // タイルの継ぎ目も目立つ(1タイル16mなので盤面には十数回繰り返される)
  for (let i = 0; i < 300; i++) {
    const r = 3 + rnd() * 13;
    g.fillStyle = rnd() < 0.5 ? "rgba(198,178,140,0.07)" : "rgba(102,86,58,0.07)";
    g.beginPath();
    g.arc(rnd() * S, rnd() * S, r, 0, Math.PI * 2);
    g.fill();
  }
  // 砂粒。1px の粒を撒くと拡大したときの解像感が出る
  for (let i = 0; i < 2800; i++) {
    g.fillStyle = rnd() < 0.5 ? "rgba(255,242,214,0.05)" : "rgba(58,46,28,0.05)";
    g.fillRect(Math.floor(rnd() * S), Math.floor(rnd() * S), 1, 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * ×印のジオメトリ(`[v6.6]`)。戦死は「色が変わる」ではなく「**円でなくなる**」で示す。
 * 交差した2本の帯を1つのジオメトリにまとめ、インスタンス1個で1名ぶんを描く。
 */
function makeCrossGeo(arm: number, thick: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  const idx: number[] = [];
  const bar = (rot: number): void => {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const base = pos.length / 3;
    // 長さ arm、太さ thick の帯を rot だけ回して置く
    for (const [u, v] of [
      [-arm, -thick],
      [arm, -thick],
      [arm, thick],
      [-arm, thick],
    ] as const) {
      pos.push(u * c - v * sn, 0, u * sn + v * c);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  bar(Math.PI / 4);
  bar(-Math.PI / 4);
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/**
 * 破線のリング(`[v6.6]`)。不確度円は**実体ではない**ことを形で示す必要がある
 * (UIレビュー 04)。`LineDashedMaterial` はインスタンス化と相性が悪いので、
 * 円弧を等間隔で間引いた面として作る。半径1で作り、描画時にスケールする。
 */
function makeDashedRingGeo(
  inner: number,
  outer: number,
  dashes: number,
  duty: number,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  const idx: number[] = [];
  const step = (Math.PI * 2) / dashes;
  for (let d = 0; d < dashes; d++) {
    const a0 = d * step;
    const a1 = a0 + step * duty;
    const base = pos.length / 3;
    for (const [r, a] of [
      [inner, a0],
      [outer, a0],
      [outer, a1],
      [inner, a1],
    ] as const) {
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

interface TickSnapshot {
  tick: number;
  pos: Map<number, { x: number; z: number; fx: number; fz: number }>;
}

function snapshot(world: World): TickSnapshot {
  const pos = new Map<number, { x: number; z: number; fx: number; fz: number }>();
  for (const s of world.soldiers) {
    pos.set(s.id, { x: s.pos.x, z: s.pos.z, fx: s.facing.x, fz: s.facing.z });
  }
  return { tick: world.tick, pos };
}

export interface Renderer {
  /**
   * 1フレーム描画する。
   * `view` は「いまどの立場から戦場を見ているか」の解決結果(仕様 §5)。
   * レンダラは world.soldiers を敵の描画には使わない — 敵は必ず view 経由
   * (神視点 `opts.truth` のときだけ `view.enemiesTruth` を実体として描く)。
   */
  render(world: World, view: ViewResult, alpha: number, opts: RenderOpts): void;
  resize(): void;
  /** 画面ピクセル下のワールド座標(将来の選択・命令発行用) */
  screenToWorld(clientX: number, clientY: number): { x: number; z: number };
  dispose(): void;
}

export function createRenderer(canvas: HTMLCanvasElement, world: World): Renderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  // 盤外は一段落とす。play area の輪郭が見えると「盤面」として読める(`[v6.5]`)
  scene.background = new THREE.Color(MAP.outOfPlay);
  /** 起動時に作る静的ジオメトリ。破棄時にまとめて解放する */
  const staticGeos: THREE.BufferGeometry[] = [];
  const staticMats: THREE.Material[] = [];
  const keepGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    staticGeos.push(g);
    return g;
  };
  const keepMat = <T extends THREE.Material>(m: T): T => {
    staticMats.push(m);
    return m;
  };

  // カメラ: 画面に収まるワールド高さ(m)が `viewSpan`。パンは target を動かす。
  // 初期値はマップ全体が収まる高さにする(マップが大きくなっても勝手に見切れない)。
  let viewSpan = (world.bounds.maxZ - world.bounds.minZ) * 1.1;
  const target = new THREE.Vector3(
    (world.bounds.minX + world.bounds.maxX) / 2,
    0,
    (world.bounds.minZ + world.bounds.maxZ) / 2,
  );
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);

  // 地面 — 砂地のテクスチャを敷く(`[v6.5]`)
  const groundW = world.bounds.maxX - world.bounds.minX;
  const groundH = world.bounds.maxZ - world.bounds.minZ;
  const groundTex = makeGroundTexture();
  // 1タイル = 16m。粗くすると引きの絵で「雲が浮いている」ように見え、細かくすると
  // 寄ったときに繰り返しが見える。異方性フィルタは斜めから見ない正射影でも効く
  groundTex.repeat.set(groundW / 16, groundH / 16);
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(
    keepGeo(new THREE.PlaneGeometry(groundW, groundH)),
    keepMat(new THREE.MeshBasicMaterial({ color: MAP.ground, map: groundTex })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(
    (world.bounds.minX + world.bounds.maxX) / 2,
    -0.01,
    (world.bounds.minZ + world.bounds.maxZ) / 2,
  );
  scene.add(ground);

  // マップ境界
  const border = new THREE.LineSegments(
    keepGeo(new THREE.EdgesGeometry(new THREE.PlaneGeometry(groundW, groundH))),
    keepMat(new THREE.LineBasicMaterial({ color: 0x6b5d45 })),
  );
  border.rotation.x = -Math.PI / 2;
  border.position.copy(ground.position);
  scene.add(border);

  // 建物の影(`[v6.5]`)。真上から見た平面図に高さの手がかりを与える唯一の要素で、
  // これが入るだけで街区が「地面に描かれた模様」から「建っているもの」に変わる。
  // 建物の床より先に描くので、床の外へはみ出した分だけが見える。
  const shadowMat = keepMat(
    new THREE.MeshBasicMaterial({
      color: MAP.shadow,
      transparent: true,
      opacity: SHADOW_OPACITY,
      depthWrite: false,
    }),
  );
  for (const b of world.buildings) {
    const m = new THREE.Mesh(
      keepGeo(
        new THREE.PlaneGeometry(b.bounds.maxX - b.bounds.minX, b.bounds.maxZ - b.bounds.minZ),
      ),
      shadowMat,
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(
      (b.bounds.minX + b.bounds.maxX) / 2 + SHADOW_DX,
      0.001,
      (b.bounds.minZ + b.bounds.maxZ) / 2 + SHADOW_DZ,
    );
    scene.add(m);
  }

  /**
   * 建物ごとの色味のばらつき(`[v6.5]`)。
   *
   * 街区34棟が完全に同じ色だと、盤面が「同じ図形の反復」に見えて、どの建物にいるのか
   * 分からなくなる。実際の市街も、日干し煉瓦・塗り壁・コンクリートが混ざっている。
   * **建物idから決めるので、点対称の双子どうしは色が違う** — 対称性の担保は
   * シムの側(壁・扉・ナビ)にあり、見た目の色はそれに関与しない。
   */
  const tintScratch = new THREE.Color();
  const buildingTint = (id: number, base: number, spread: number): number => {
    const h = ((id * 2654435761) >>> 0) / 4294967296;
    return tintScratch
      .setHex(base)
      .offsetHSL(0, (h - 0.5) * 0.05, (h - 0.5) * spread)
      .getHex();
  };

  // 建物の床(仕様 §7.1: 屋外と屋内はシームレスな1つのマップ)。
  // 壁より先に描いて、部屋の広がりが分かるようにする
  const floorMats = new Map<number, THREE.MeshBasicMaterial>();
  for (const b of world.buildings) {
    const floorMat = keepMat(
      new THREE.MeshBasicMaterial({ color: buildingTint(b.id, MAP.roomFloor, 0.1) }),
    );
    floorMats.set(b.id, floorMat);
    for (const r of b.rooms) {
      const floor = new THREE.Mesh(
        keepGeo(
          new THREE.PlaneGeometry(r.bounds.maxX - r.bounds.minX, r.bounds.maxZ - r.bounds.minZ),
        ),
        floorMat,
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(
        (r.bounds.minX + r.bounds.maxX) / 2,
        0.005,
        (r.bounds.minZ + r.bounds.maxZ) / 2,
      );
      scene.add(floor);
    }
  }

  /**
   * 壁 — 数が少ないので個別メッシュで足りる。
   * world.walls は扉の開閉で変化するので、**構造物の壁だけ**を描く。
   *
   * `[v6.5]` 建物の壁と街路の低い遮蔽(塀・土嚢・車列)を色で分ける。同じ色だと
   * 街区の輪郭と街路の遮蔽が地続きに見えて、どこが建物でどこが通りかが読めない。
   * 建物に属するかは所属テーブルを持たないので、外周に触れているかで判定する。
   */
  const clutterMat = keepMat(new THREE.MeshBasicMaterial({ color: MAP.clutter }));
  const wallMats = new Map<number, THREE.MeshBasicMaterial>();
  for (const b of world.buildings) {
    wallMats.set(
      b.id,
      keepMat(new THREE.MeshBasicMaterial({ color: buildingTint(b.id, MAP.wall, 0.12) })),
    );
  }
  const buildingIdOfWall = (w: { cx: number; cz: number }): number | null =>
    world.buildings.find(
      (b) =>
        w.cx >= b.bounds.minX - 0.8 &&
        w.cx <= b.bounds.maxX + 0.8 &&
        w.cz >= b.bounds.minZ - 0.8 &&
        w.cz <= b.bounds.maxZ + 0.8,
    )?.id ?? null;
  // ── 窓(`[v6.10]` 仕様 §7)──
  //
  // 壁の切れ目として描くだけでは、街区の輪郭がただ虫食いに見える。開口の位置に
  // **枠**を1枚置いて、そこが銃眼であることを示す。壁より明るく、扉より暗い —
  // 通れないが見通せる、という中間の性質をそのまま明度で並べてある。
  const windowMat = keepMat(
    new THREE.MeshBasicMaterial({ color: MAP.window }),
  );
  for (const b of world.buildings) {
    for (const win of b.windows) {
      // 開口の向きに合わせて細長い板を置く(法線方向に薄く、面に沿って窓幅)
      const along = Math.abs(win.normal.x) > 0.5;
      // **壁と同じ高さにする**(`[v6.15]`)。以前は高さ1.25で上端が1.93、壁の上端2.0
      // より低かったので、真上から見ると壁の天面に隠れて見えなかった。
      // 気持ち高く(2.1)して、隣の壁と重なる部分でも必ず手前に出す
      const m = new THREE.Mesh(
        keepGeo(
          along
            ? new THREE.BoxGeometry(0.55, 2.1, WINDOW_DRAW_W)
            : new THREE.BoxGeometry(WINDOW_DRAW_W, 2.1, 0.55),
        ),
        windowMat,
      );
      m.position.set(win.pos.x, 1.05, win.pos.z);
      scene.add(m);
    }
  }

  for (const w of world.structuralWalls) {
    const bid = buildingIdOfWall(w);
    const building = bid !== null;
    const m = new THREE.Mesh(
      keepGeo(new THREE.BoxGeometry(w.hw * 2, 2, w.hd * 2)),
      (bid !== null ? wallMats.get(bid) : undefined) ?? clutterMat,
    );
    m.position.set(w.cx, 1, w.cz);
    scene.add(m);
    // 街路の遮蔽にも短い影を落とす。建物と同じ方向にずらして光源を1つに保つ
    if (!building) {
      const sh = new THREE.Mesh(
        keepGeo(new THREE.PlaneGeometry(w.hw * 2, w.hd * 2)),
        shadowMat,
      );
      sh.rotation.x = -Math.PI / 2;
      sh.position.set(w.cx + SHADOW_DX * 0.4, 0.0015, w.cz + SHADOW_DZ * 0.4);
      scene.add(sh);
    }
  }

  // 扉(仕様 §7.6): 開閉が視界の境界線になるので、状態が一目で分かるようにする
  const doorMeshes = world.doors.map((d) => {
    const alongX = Math.abs(d.normal.x) > Math.abs(d.normal.z);
    const m = new THREE.Mesh(
      keepGeo(new THREE.BoxGeometry(alongX ? 0.35 : d.width, 1.8, alongX ? d.width : 0.35)),
      new THREE.MeshBasicMaterial({ color: MAP.doorClosed }),
    );
    m.position.set(d.pos.x, 0.9, d.pos.z);
    scene.add(m);
    return m;
  });

  // 拠点(仕様 §12)。所有と確保進捗が一目で分かるよう、外周リングと進捗リングを分ける
  /**
   * 拠点のリング・確保の塗り・標。
   *
   * ジオメトリ側を寝かせる(`geo.rotateX`)こと。**メッシュを `rotation.x` で寝かせて
   * から `scale` すると潰れる** — スケールはローカル空間に効くので、寝かせた面の
   * 奥行きに当たるのはローカルYで、`scale.set(r, 1, r)` はそこへ 1 を掛けてしまう。
   * 確保の塗りと標が横長のレンズに見えていたのはこれ(`[v6.6]` で修正)。
   */
  const flatGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    g.rotateX(-Math.PI / 2);
    return g;
  };
  const objectiveRings = world.objectives.map((o) => {
    const outer = new THREE.Mesh(
      keepGeo(flatGeo(new THREE.RingGeometry(o.radius - 0.5, o.radius, 48))),
      new THREE.MeshBasicMaterial({
        color: MAP.safe,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    );
    outer.position.set(o.pos.x, 0.02, o.pos.z);
    scene.add(outer);

    // 進捗は内側の円盤の大きさで示す(0 で消え、1 で外周に届く)
    const fill = new THREE.Mesh(
      keepGeo(flatGeo(new THREE.CircleGeometry(1, 32))),
      new THREE.MeshBasicMaterial({
        color: MAP.safe,
        transparent: true,
        opacity: 0.26,
        side: THREE.DoubleSide,
      }),
    );
    fill.position.set(o.pos.x, 0.015, o.pos.z);
    scene.add(fill);

    /**
     * 拠点の標(`[v6.5]`)。**画面上の大きさを一定に保つ**ため、毎フレーム
     * `viewSpan` に比例させて拡大する。拠点は建物の一室(半径3m)まで絞ってあるので、
     * 盤面全体を見ているとリングが十数ピクセルになり、どこが拠点か分からなかった。
     */
    const pin = new THREE.Mesh(
      keepGeo(flatGeo(new THREE.CircleGeometry(1, 4))),
      new THREE.MeshBasicMaterial({
        color: MAP.safe,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    // 立案の接近経路(renderOrder 23)より上。矢羽根が目標に重なるので、
    // 標が下敷きになると「どこが拠点か」が読めなくなる
    pin.renderOrder = 25;
    scene.add(pin);
    return { outer, fill, pin };
  });
  /** 標の大きさ = `viewSpan` × これ。画面高さに対する比になる */
  const OBJ_PIN_SCREEN_FRAC = 0.016;

  // 負傷者集合点(CCP、仕様 §9)。担架班の搬送先なので、常に両陣営分を描く。
  for (const side of ["blue", "red"] as Side[]) {
    const p = world.ccp[side];
    const ring = new THREE.Mesh(
      keepGeo(new THREE.RingGeometry(LITTER.EVAC_RADIUS - 0.45, LITTER.EVAC_RADIUS, 32)),
      keepMat(
        new THREE.MeshBasicMaterial({
          color: SIDE_COLOR[side],
          transparent: true,
          opacity: 0.6,
          side: THREE.DoubleSide,
        }),
      ),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.02, p.z);
    scene.add(ring);
    // CCPだと分かるよう十字を重ねる(衛生標識の見立て)
    const cross = new THREE.Mesh(
      keepGeo(new THREE.PlaneGeometry(1.6, 0.5)),
      keepMat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })),
    );
    cross.rotation.x = -Math.PI / 2;
    cross.position.set(p.x, 0.021, p.z);
    scene.add(cross);
    const cross2 = cross.clone();
    cross2.rotation.z = Math.PI / 2;
    scene.add(cross2);
  }

  /**
   * 兵士の影(`[v6.5]`)。円盤の下に少しずらした暗い円を敷く。
   *
   * 目的は雰囲気ではなく**可読性**で、明るい砂地の上ではトークンの縁が地に溶ける。
   * 建物の影と同じ方向・同じ色にしてあるので、盤面全体で光源が1つに見える。
   */
  const soldierShadowGeo = new THREE.CircleGeometry(TOKEN_R * 1.06, 12);
  soldierShadowGeo.rotateX(-Math.PI / 2);
  const soldierShadowMesh = new THREE.InstancedMesh(
    soldierShadowGeo,
    new THREE.MeshBasicMaterial({
      color: MAP.shadow,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
    MAX_SOLDIERS,
  );
  soldierShadowMesh.frustumCulled = false;
  scene.add(soldierShadowMesh);

  /** インスタンス化メッシュを作る小道具。色は毎フレーム差し替える */
  const makeInstanced = (
    geo: THREE.BufferGeometry,
    count: number,
    opts: THREE.MeshBasicMaterialParameters = {},
    order = 0,
  ): THREE.InstancedMesh => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(opts), count);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    m.frustumCulled = false;
    m.renderOrder = order;
    m.count = 0;
    scene.add(m);
    return m;
  };

  // ── 兵士トークン: 芯(円盤)/ 状態リング / 制圧リング / 戦死の× / 向き / 階級 ──
  // UIレビュー 04「兵士1点を『陣営 × 状態 × 階級』の3層で組む」。
  // 状態ごとに色を増やすのではなく、**同じ円に足したり抜いたりする**ので、
  // 引きの絵では芯の色だけが残り、寄ると状態と階級が読める。
  const discGeo = new THREE.CircleGeometry(TOKEN_R, 16);
  discGeo.rotateX(-Math.PI / 2);
  const discMesh = makeInstanced(discGeo, MAX_SOLDIERS);

  /** 状態リング: 負傷の「抜き円」の輪、担架要員の内リング。半径はトークンと同じ */
  const bodyRingGeo = new THREE.RingGeometry(TOKEN_R * BODY_RING_IN, TOKEN_R * BODY_RING_OUT, 20);
  bodyRingGeo.rotateX(-Math.PI / 2);
  const bodyRingMesh = makeInstanced(bodyRingGeo, MAX_SOLDIERS, {}, 11);

  /** 制圧リング: トークンの**外**に足す細い白リング。陣営色は置き換えない */
  const haloRingGeo = new THREE.RingGeometry(TOKEN_R * HALO_RING_IN, TOKEN_R * HALO_RING_OUT, 20);
  haloRingGeo.rotateX(-Math.PI / 2);
  const haloRingMesh = makeInstanced(
    haloRingGeo,
    MAX_SOLDIERS,
    { transparent: true, opacity: 0.9 },
    10,
  );

  /** 戦死の×。円をやめて形が変わるので、引きの絵でも「もう円ではない」で読める */
  const kiaGeo = makeCrossGeo(TOKEN_R * KIA_ARM, TOKEN_R * KIA_THICK);
  const kiaMesh = makeInstanced(kiaGeo, MAX_SOLDIERS, {}, 9);

  // 向きを示すくさび形。陣営色のまま明度だけ上げる(白にすると「プレイヤーの向き
  // 三角」に見え、同色だと円盤に溶けて向きが読めない)
  const wedgeGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 1.5, 3);
  wedgeGeo.rotateX(-Math.PI / 2);
  const wedgeMesh = makeInstanced(wedgeGeo, MAX_SOLDIERS);

  // 階級章。単位平面を1枚用意し、横棒の長さにスケールする(UIレビュー 診断D)
  const rankGeo = new THREE.PlaneGeometry(1, 1);
  rankGeo.rotateX(-Math.PI / 2);
  const rankMesh = makeInstanced(
    rankGeo,
    MAX_RANK_MARKS,
    { transparent: true, opacity: 0.95, depthTest: false },
    12,
  );

  /**
   * 担架搬送の「関係」の線(UIレビュー 診断C)。
   * 搬送は2名の関係なので、点1個の色では表せない — 運ぶ側と運ばれる側を線で結ぶ。
   */
  const litterGeo = new THREE.BufferGeometry();
  litterGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MAX_SOLDIERS * 2 * 3), 3),
  );
  const litterLines = new THREE.LineSegments(
    litterGeo,
    new THREE.LineBasicMaterial({
      color: MAP.live,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    }),
  );
  litterLines.renderOrder = 13;
  litterLines.frustumCulled = false;
  scene.add(litterLines);
  const litterPos = litterGeo.getAttribute("position") as THREE.BufferAttribute;

  // 敵接触マーカー — 実体ではなく「報告された最終目撃位置」を描く(仕様 §5)。
  // 塗りの菱形 + 輪郭で、味方のベタ塗り円と形でも描き分ける。
  const contactGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 2.0, 4);
  contactGeo.rotateX(-Math.PI / 2);
  const contactMesh = makeInstanced(contactGeo, MAX_CONTACTS, { transparent: true, opacity: 0.5 });
  const contactEdgeGeo = new THREE.RingGeometry(SOLDIER_RADIUS * 1.6, SOLDIER_RADIUS * 2.0, 4);
  contactEdgeGeo.rotateX(-Math.PI / 2);
  const contactEdgeMesh = makeInstanced(contactEdgeGeo, MAX_CONTACTS, {
    transparent: true,
    opacity: 0.95,
  });

  // 不確度円(仕様 §5)。**破線**にして実体(実線・円)と描き分ける — 実体と
  // 見間違えると本作の情報設計が伝わらない(UIレビュー 04)。
  const errorRingGeo = makeDashedRingGeo(0.94, 1.0, 20, 0.55);
  const errorRingMesh = makeInstanced(errorRingGeo, MAX_CONTACTS, {
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
  });

  // ── 操作中 / 選択ハイライト(指摘: いまどの階層・代表ユニットを操作しているか) ──
  const makeHiRing = (color: number, seg: number, inner: number, outer: number) => {
    const g = new THREE.RingGeometry(SOLDIER_RADIUS * inner, SOLDIER_RADIUS * outer, seg);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    m.renderOrder = 20;
    m.visible = false;
    scene.add(m);
    return m;
  };
  const controlRing = makeHiRing(MAP.text, 40, 2.4, 3.0);
  const selectRing = makeHiRing(MAP.live, 4, 2.7, 3.3);

  // ── 麾下ユニットの強調(`[v6.4]` 4回目のテストプレイ指摘⑤)──
  // 選択した指揮官の指揮下にある兵士へリングを敷き、直属の下位指揮官へは線を引く。
  // 誰が誰の下にいるのかは §12 の継承結果(commanderId)から引くので、
  // 指揮官が倒れて次席が引き継げば強調範囲もそのまま移る。
  const subRingGeo = new THREE.RingGeometry(SOLDIER_RADIUS * 1.9, SOLDIER_RADIUS * 2.25, 20);
  subRingGeo.rotateX(-Math.PI / 2);
  const subRingMesh = new THREE.InstancedMesh(
    subRingGeo,
    new THREE.MeshBasicMaterial({
      color: MAP.live,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
    MAX_SOLDIERS,
  );
  subRingMesh.renderOrder = 17;
  subRingMesh.frustumCulled = false;
  subRingMesh.count = 0;
  scene.add(subRingMesh);

  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MAX_COMMAND_LINKS * 2 * 3), 3),
  );
  const linkLines = new THREE.LineSegments(
    linkGeo,
    new THREE.LineBasicMaterial({
      color: MAP.live,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
    }),
  );
  linkLines.renderOrder = 17;
  linkLines.frustumCulled = false;
  linkLines.visible = false;
  scene.add(linkLines);
  const linkPos = linkGeo.getAttribute("position") as THREE.BufferAttribute;

  // ── 前線(FLOT)と火力の統制線(`[v6.16]` 仕様 §5/§11)──
  //
  // **これは盤面の事実ではなく、中隊長の頭の中にある線である。** 麾下小隊からの
  // 無線報告だけで引かれていて、2ホップぶん古い。だから兵士の実際の位置とずれる
  // ことがあり、**ずれて見えるのが正しい**。ここを真値で描くと、仕様 §5 が守られて
  // いることが画面から確認できなくなる。
  //
  // 2本ある(`sim/c2/flot.ts` の Flot が2つの値を持つのと同じ理由):
  //   前線     部隊の指向に使う線。掩護部隊を除いた線(FM 3-90)
  //   統制線   ここより手前へは迫撃砲を撃たない線(FSCM)。先頭 + 危険近接
  const makeDashes = (color: number, opacity: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FLOT_DASHES * 2 * 3), 3));
    const l = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
    );
    l.renderOrder = 16;
    l.frustumCulled = false;
    l.visible = false;
    scene.add(l);
    return { geo: g, line: l, pos: g.getAttribute("position") as THREE.BufferAttribute, n: 0 };
  };
  type Dashes = ReturnType<typeof makeDashes>;
  /** 中隊長の前線(太い1本)/ 小隊長の前線(細い複数)/ 火力の統制線 */
  const flotLine = makeDashes(MAP.live, 0.9);
  const flotSubLine = makeDashes(MAP.live, 0.28);
  const fscmLine = makeDashes(MAP.warn, 0.45);

  /**
   * 折れ線を破線として `d` へ書き足す(`[v6.17]`)。
   *
   * 頂点そのものではなく**線分に沿って等間隔に刻む**ので、部隊の間隔が広くても
   * 破線の見た目が変わらない。両端は末端の線分の向きへ `FLOT_EXTEND` だけ延ばす —
   * 実際の作戦図でも前線は隣接部隊の担当区域へ続いていく。
   */
  const addPolylineDashes = (
    d: Dashes,
    pts: ReadonlyArray<Vec2>,
    y: number,
    style: { dash: number; gap: number; extend: number },
  ): void => {
    if (pts.length === 0) return;
    const path: Vec2[] = [...pts];
    if (path.length === 1) return; // 1点では線にならない(部下が1個だけ)
    if (style.extend > 0) {
      const ext = (from: Vec2, to: Vec2): Vec2 => {
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const len = Math.hypot(dx, dz) || 1;
        return { x: to.x + (dx / len) * style.extend, z: to.z + (dz / len) * style.extend };
      };
      path.unshift(ext(path[1]!, path[0]!));
      path.push(ext(path[path.length - 2]!, path[path.length - 1]!));
    }

    const span = style.dash + style.gap;
    let carry = 0; // 前の線分から持ち越した「次の破線が始まるまでの距離」
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const ux = dx / len;
      const uz = dz / len;
      for (let s = carry; s < len; s += span) {
        if (d.n >= FLOT_DASHES) return;
        const e = Math.min(s + style.dash, len);
        d.pos.setXYZ(2 * d.n, a.x + ux * s, y, a.z + uz * s);
        d.pos.setXYZ(2 * d.n + 1, a.x + ux * e, y, a.z + uz * e);
        d.n++;
      }
      // 線分をまたいでも破線の刻みが揃うように余りを持ち越す
      carry = ((carry - len) % span + span) % span;
    }
  };

  const beginDashes = (d: Dashes): void => {
    d.n = 0;
  };
  const endDashes = (d: Dashes): void => {
    d.geo.setDrawRange(0, d.n * 2);
    d.pos.needsUpdate = true;
    d.line.visible = d.n > 0;
  };

  // ── 配置エディタの計画マーカー(`[v6.4]`)──
  // 「これから作り直す盤面の予定」を薄く重ねる。実際の兵士・拠点とは別物なので、
  // 塗りつぶさず輪郭だけにして、現在の戦況の上に重なっても読み取りを邪魔しない。
  const setupRing = (color: number, inner: number, outer: number, seg: number) => {
    const g = new THREE.RingGeometry(inner, outer, seg);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    m.renderOrder = 24;
    m.visible = false;
    scene.add(m);
    return m;
  };
  const spawnMarks: Record<Side, THREE.Mesh> = {
    blue: setupRing(SIDE_COLOR.blue, 5.2, 6.4, 40),
    red: setupRing(SIDE_COLOR.red, 5.2, 6.4, 40),
  };
  /** 展開点の正面を示す矢羽根(三角) */
  const spawnArrow = (color: number) => {
    const g = new THREE.CircleGeometry(2.6, 3);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthTest: false }),
    );
    m.renderOrder = 24;
    m.visible = false;
    scene.add(m);
    return m;
  };
  const spawnArrows: Record<Side, THREE.Mesh> = {
    blue: spawnArrow(SIDE_COLOR.blue),
    red: spawnArrow(SIDE_COLOR.red),
  };
  const MAX_SETUP_OBJ = 16;
  // 予定の拠点は「細いリング + 中心の菱形」。実際の拠点(太いリング + 確保の塗り)と
  // 形でも色でも区別できるようにする
  const setupObjMarks = Array.from({ length: MAX_SETUP_OBJ }, () =>
    setupRing(PLAN_COLOR, 0.93, 1.0, 32),
  );
  const setupObjPins = Array.from({ length: MAX_SETUP_OBJ }, () => {
    const g = new THREE.CircleGeometry(1.1, 4);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ color: PLAN_COLOR, transparent: true, opacity: 0.75, depthTest: false }),
    );
    m.renderOrder = 24;
    m.visible = false;
    scene.add(m);
    return m;
  });

  // ── 移動命令の可視化(指摘: 移動命令が出せているか分からない) ──
  const orderMarkerGeo = new THREE.RingGeometry(0.7, 1.05, 4);
  orderMarkerGeo.rotateX(-Math.PI / 2);
  const orderMarker = new THREE.Mesh(
    orderMarkerGeo,
    new THREE.MeshBasicMaterial({
      color: MAP.warn,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  );
  orderMarker.renderOrder = 19;
  orderMarker.visible = false;
  scene.add(orderMarker);

  const makePolyline = (color: number, opacity: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    const l = new THREE.Line(
      g,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
    );
    l.renderOrder = 18;
    l.visible = false;
    l.frustumCulled = false;
    scene.add(l);
    return l;
  };
  const orderLine = makePolyline(MAP.warn, 0.85); // 操作中ユニット → 目的地
  const controlPathLine = makePolyline(MAP.warn, 0.6); // 操作中ユニットの計画経路
  const selectPathLine = makePolyline(MAP.live, 0.7); // 選択ユニットの計画経路

  // ── 作戦の接近経路(`[v6.5]`)── 立案フェーズにだけ出る。折れ線 + 先端の矢羽根。
  const MAX_PLAN_ROUTES = 12;
  const planRouteLines = Array.from({ length: MAX_PLAN_ROUTES }, () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
    const l = new THREE.Line(
      g,
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false }),
    );
    l.renderOrder = 23;
    l.frustumCulled = false;
    l.visible = false;
    scene.add(l);
    return l;
  });
  const planArrows = Array.from({ length: MAX_PLAN_ROUTES }, () => {
    const g = new THREE.CircleGeometry(3.2, 3);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false }),
    );
    m.renderOrder = 23;
    m.visible = false;
    scene.add(m);
    return m;
  });
  /**
   * 接近経路に沿って撒く小さな山形(シェブロン)。
   * `LineBasicMaterial` の線幅はほとんどのブラウザで1pxに固定されるので、
   * 折れ線だけだと引きの絵で経路が読めない。進行方向を向いた印を等間隔で置く。
   */
  const CHEVRON_SPACING = 14;
  const MAX_CHEVRONS = 360;
  const chevronGeo = new THREE.CircleGeometry(1.5, 3);
  chevronGeo.rotateX(-Math.PI / 2);
  const chevronMesh = new THREE.InstancedMesh(
    chevronGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false }),
    MAX_CHEVRONS,
  );
  chevronMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_CHEVRONS * 3),
    3,
  );
  chevronMesh.renderOrder = 23;
  chevronMesh.frustumCulled = false;
  chevronMesh.count = 0;
  scene.add(chevronMesh);

  // ── 発砲線(指摘: 撃った時の線) ── 1本のLineSegmentsを毎フレーム詰め替える
  const tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 2 * 3), 3),
  );
  tracerGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 2 * 3), 3));
  const tracerMesh = new THREE.LineSegments(
    tracerGeo,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }),
  );
  tracerMesh.renderOrder = 22;
  tracerMesh.frustumCulled = false;
  scene.add(tracerMesh);

  // ── 擲弾の着弾円(指摘: 榴弾は範囲攻撃なのでもっと見えるように) ──
  const blastPool = Array.from({ length: MAX_BLASTS }, () => {
    const fillGeo = new THREE.CircleGeometry(1, 28);
    fillGeo.rotateX(-Math.PI / 2);
    const fill = new THREE.Mesh(
      fillGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    const ringGeo = new THREE.RingGeometry(0.92, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    fill.renderOrder = 21;
    ring.renderOrder = 21;
    fill.visible = false;
    ring.visible = false;
    scene.add(fill);
    scene.add(ring);
    return { fill, ring };
  });

  // ── 迫撃砲の着弾(`[v6.9]`)──
  //
  // 擲弾と同じ2層(火球+衝撃波)に、外側の**土煙**を1枚足して3層にしてある。
  // 土煙は制圧の及ぶ範囲そのものなので、「あの円の中は撃たれても当たらない」が
  // そのまま目で分かる — 見た目のためだけの層ではない(仕様 §8.6)。
  const mortarPool = Array.from({ length: MAX_BLASTS }, () => {
    const disc = (): THREE.Mesh => {
      const g = new THREE.CircleGeometry(1, 40);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      m.renderOrder = 24;
      m.visible = false;
      scene.add(m);
      return m;
    };
    const ring = (inner: number): THREE.Mesh => {
      const g = new THREE.RingGeometry(inner, 1, 56);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthTest: false,
        }),
      );
      m.renderOrder = 24;
      m.visible = false;
      scene.add(m);
      return m;
    };
    return { core: disc(), shock: ring(0.82), dust: ring(0.9) };
  });

  // ── 破片の飛散線(`[v6.9]`)── 着弾点から放射状に伸びて消える
  const debrisGeo = new THREE.BufferGeometry();
  debrisGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MAX_DEBRIS * 2 * 3), 3),
  );
  debrisGeo.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(MAX_DEBRIS * 2 * 3), 3),
  );
  const debrisMesh = new THREE.LineSegments(
    debrisGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  debrisMesh.renderOrder = 25;
  debrisMesh.frustumCulled = false;
  scene.add(debrisMesh);

  // ── 着弾前の警告(`[v6.9]`)──
  //
  // 飛翔中の射撃任務を、**縮んでいくリング**として照準点に出す。着弾の瞬間だけ
  // 光らせるのでは「何が起きたか」しか分からないが、これがあると「何が起きるか」
  // が分かる — 部隊を退かす時間が生まれ、迫撃砲が盤面の駆け引きになる。
  // 色は撃っている側の陣営色。仕様 §5 の情報階層には掛けない — 砲声と弾着観測は
  // 両軍に聞こえるものなので、砲兵の存在は隠さない(隠すのは敵**部隊**の位置)。
  const incomingPool = Array.from({ length: MAX_INCOMING }, () => {
    const ringGeo = new THREE.RingGeometry(0.9, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    // 中心の十字。リングだけだと拠点のリングと見分けがつかない
    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 1]),
        3,
      ),
    );
    const cross = new THREE.LineSegments(
      crossGeo,
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthTest: false }),
    );
    ring.renderOrder = 24;
    cross.renderOrder = 24;
    ring.visible = false;
    cross.visible = false;
    scene.add(ring);
    scene.add(cross);
    return { ring, cross };
  });

  // ── デバッグ: 視界扇形(FOV) ── ジオメトリは tuning 変化時に作り直す
  const buildConeGeo = (halfRad: number, range: number): THREE.BufferGeometry => {
    const shape = new THREE.Shape();
    const segs = 24;
    shape.moveTo(0, 0);
    for (let i = 0; i <= segs; i++) {
      const a = -halfRad + (2 * halfRad * i) / segs;
      shape.lineTo(Math.sin(a) * range, Math.cos(a) * range);
    }
    shape.lineTo(0, 0);
    const g = new THREE.ShapeGeometry(shape);
    // Shape の +Y をローカル +Z(前方)へ。instance の rotationY(heading) で
    // ローカル +Z が world (sin heading, cos heading) = 兵士の向きに一致する。
    g.rotateX(Math.PI / 2);
    return g;
  };
  let coneHalf = world.tuning.fovHalfRad;
  let coneRange = world.tuning.detectRange;
  let coneGeo = buildConeGeo(coneHalf, coneRange);
  const fovMesh = new THREE.InstancedMesh(
    coneGeo,
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    MAX_SOLDIERS,
  );
  fovMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SOLDIERS * 3), 3);
  fovMesh.count = 0;
  fovMesh.frustumCulled = false;
  scene.add(fovMesh);

  // ── デバッグ: 隠蔽率カラーグリッド(選択ユニット視点の視認可否 × 地形カバー) ──
  const cellGeo = new THREE.PlaneGeometry(GRID_CELL * 0.92, GRID_CELL * 0.92);
  cellGeo.rotateX(-Math.PI / 2);
  const gridMesh = new THREE.InstancedMesh(
    cellGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthWrite: false }),
    MAX_GRID_CELLS,
  );
  gridMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_GRID_CELLS * 3),
    3,
  );
  gridMesh.count = 0;
  gridMesh.frustumCulled = false;
  scene.add(gridMesh);
  /** グリッド再計算のキャッシュキー(選択・tick・tuning が変わったときだけ組み直す) */
  let gridKey = "";

  const tracerPos = tracerGeo.getAttribute("position") as THREE.BufferAttribute;
  const tracerColArr = tracerGeo.getAttribute("color") as THREE.BufferAttribute;
  let tracers: Tracer[] = [];
  let blasts: Blast[] = [];
  let debris: Debris[] = [];
  const debrisPos = debrisGeo.getAttribute("position") as THREE.BufferAttribute;
  const debrisCol = debrisGeo.getAttribute("color") as THREE.BufferAttribute;
  /** 破片の方向を決める決定論的な擬似乱数(描画専用。シムの乱数には触れない) */
  let debrisSeed = 1;
  const debrisRand = (): number => {
    debrisSeed = (debrisSeed * 1664525 + 1013904223) >>> 0;
    return debrisSeed / 4294967296;
  };
  let lastFxTick = world.tick;
  let lastFrameMs = performance.now();

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const col2 = new THREE.Color();
  /** 兵士ID → 階級(毎フレーム作り直す)。`[v6.2]` 階級章の描画に使う */
  const rankOf = new Map<number, number>();

  let prev: TickSnapshot = snapshot(world);
  let cur: TickSnapshot = prev;
  let lastTick = world.tick;

  function updateCamera(): void {
    const rect = canvas.getBoundingClientRect();
    const aspect = rect.width / Math.max(1, rect.height);
    const halfH = viewSpan / 2;
    const halfW = halfH * aspect;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.position.set(target.x, 100, target.z);
    camera.lookAt(target.x, 0, target.z);
    camera.updateProjectionMatrix();
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    updateCamera();
  }

  /** world.control が指す上位ノードの現在の任務目標(移動命令マーカー用)。 */
  function controlObjective(): Vec2 | null {
    const c = world.control;
    if (!c) return null;
    if (c.echelon === "squad")
      return world.squads.find((s) => s.side === c.side && s.squadId === c.unitId)?.objective ?? null;
    if (c.echelon === "platoon")
      return (
        world.platoons.find((p) => p.side === c.side && p.platoonId === c.unitId)?.objective ?? null
      );
    if (c.echelon === "company")
      return (
        world.companies.find((x) => x.side === c.side && x.companyId === c.unitId)?.objective ?? null
      );
    return null;
  }

  function setPolyline(line: THREE.Line, pts: ReadonlyArray<Vec2>, y: number): void {
    const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = Math.min(pts.length, attr.count);
    for (let idx = 0; idx < n; idx++) attr.setXYZ(idx, pts[idx]!.x, y, pts[idx]!.z);
    line.geometry.setDrawRange(0, n);
    attr.needsUpdate = true;
    line.visible = n >= 2;
  }

  function render(world: World, view: ViewResult, alpha: number, opts: RenderOpts): void {
    const nowMs = performance.now();
    const dt = Math.min(0.05, Math.max(0, (nowMs - lastFrameMs) / 1000));
    lastFrameMs = nowMs;

    // 扉の開閉を反映する。開いた扉は薄くして「通り抜けられる」ことを示す
    world.doors.forEach((d, i) => {
      const m = doorMeshes[i];
      if (!m) return;
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setHex(d.open ? MAP.doorOpen : MAP.doorClosed);
      m.scale.y = d.open ? 0.12 : 1;
    });

    // 拠点の所有と確保進捗(仕様 §12)
    world.objectives.forEach((o, i) => {
      const r = objectiveRings[i];
      if (!r) return;
      const owner = o.owner ?? o.progressBy;
      const color = o.contested
        ? MAP.warn
        : owner
          ? SIDE_COLOR[owner]
          : MAP.safe;
      (r.outer.material as THREE.MeshBasicMaterial).color.setHex(color);
      (r.fill.material as THREE.MeshBasicMaterial).color.setHex(color);
      (r.pin.material as THREE.MeshBasicMaterial).color.setHex(color);
      const s = Math.max(0.001, o.progress * o.radius);
      r.fill.scale.set(s, 1, s);
      // 標は画面上で一定の大きさ。拠点が1室でも引きの絵で見つけられるように
      const pinR = viewSpan * OBJ_PIN_SCREEN_FRAC;
      r.pin.position.set(o.pos.x, 0.14, o.pos.z);
      r.pin.scale.set(pinR, 1, pinR);
    });

    if (world.tick !== lastTick) {
      prev = cur;
      cur = snapshot(world);
      lastTick = world.tick;
    }
    const a = prev === cur ? 1 : alpha;

    /** 兵士1名の補間済み位置と向き。 */
    const interp = (id: number): { x: number; z: number; heading: number } | null => {
      const p = prev.pos.get(id);
      const c = cur.pos.get(id) ?? p;
      if (!p || !c) return null;
      return {
        x: p.x + (c.x - p.x) * a,
        z: p.z + (c.z - p.z) * a,
        heading: Math.atan2(p.fx + (c.fx - p.fx) * a, p.fz + (c.fz - p.fz) * a),
      };
    };

    // ── 味方トークン + 神視点では敵も実体トークンで描く(指摘: 神視点で全ユニットを方向含めて) ──
    const tokens: Soldier[] = opts.truth
      ? view.friendly.concat(view.enemiesTruth)
      : view.friendly;

    // 階級は指揮継承の結果から引く(仕様 §12)。肩書きのフラグではなく commanderId を
    // 見るので、分隊長が倒れて次席のFTリーダーが引き継げば階級章もそちらへ移る。
    rankOf.clear();
    for (const co of world.companies) {
      if (co.commanderId !== null) rankOf.set(co.commanderId, RANK_COMPANY);
    }
    for (const pl of world.platoons) {
      if (pl.commanderId !== null) rankOf.set(pl.commanderId, RANK_PLATOON);
    }
    for (const sq of world.squads) {
      if (sq.commanderId !== null && !rankOf.has(sq.commanderId)) {
        rankOf.set(sq.commanderId, RANK_SQUAD);
      }
    }

    // ── 縮尺による間引き(UIレビュー 04)。判定はここ1箇所だけ ──
    const pxPerMeter = canvas.clientHeight / viewSpan;
    const tokenPx = TOKEN_R * 2 * pxPerMeter;
    const lod: Lod = tokenPx >= LOD_NEAR_PX ? "near" : tokenPx >= LOD_MID_PX ? "mid" : "far";
    const showRank = lod !== "far";
    const showState = lod !== "far"; // 状態リング(制圧・負傷の抜き円・担架の内リング)
    const showWedge = lod === "near";

    let rankN = 0;
    /**
     * 階級の横棒を1本置く。`len` は棒の長さ m、`row` は下から数えた段。
     * トークンの**上**(画面上 = −Z)へ積むので、点の状態表示と干渉しない。
     */
    const putBar = (x: number, z: number, len: number, row: number): void => {
      if (rankN >= MAX_RANK_MARKS) return;
      const thick = TOKEN_R * 2 * BAR_THICK;
      const gap = TOKEN_R * 2 * BAR_GAP;
      dummy.position.set(x, 0.11, z - TOKEN_R - gap - thick / 2 - row * (thick + gap * 0.6));
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(len, 1, thick);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      rankMesh.setMatrixAt(rankN, dummy.matrix);
      rankMesh.setColorAt(rankN, col.setHex(MAP.rank));
      rankN++;
    };

    let i = 0;
    let bodyN = 0;
    let haloN = 0;
    let kiaN = 0;
    let wedgeN = 0;
    let litterN = 0;
    for (const s of tokens) {
      const p = prev.pos.get(s.id) ?? cur.pos.get(s.id)!;
      const c = cur.pos.get(s.id) ?? p;
      const x = p.x + (c.x - p.x) * a;
      const z = p.z + (c.z - p.z) * a;
      const fx = p.fx + (c.fx - p.fx) * a;
      const fz = p.fz + (c.fz - p.fz) * a;
      const heading = Math.atan2(fx, fz);

      const dead = s.status === "kia";
      const wounded = s.status === "wia";
      const bearer = s.status === "ok" && s.bearing !== null;
      const suppressed = s.status === "ok" && s.suppressedUntilTick > world.tick;

      // 影。戦死者は伏せているので薄く小さく(`[v6.5]`)
      dummy.position.set(x + SHADOW_DX * 0.09, 0.04, z + SHADOW_DZ * 0.09);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(dead ? 0.6 : 1);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      soldierShadowMesh.setMatrixAt(i, dummy.matrix);

      if (dead) {
        // ── 戦死: 円をやめて暗い×(UIレビュー 04)。芯は描かない ──
        dummy.position.set(x, 0.05, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        kiaMesh.setMatrixAt(kiaN, dummy.matrix);
        kiaMesh.setColorAt(kiaN, col.setHex(MAP.kia));
        kiaN++;
        // 芯は原点外へ退避(インスタンス数を揃えるため空回しはしない)
        dummy.position.set(x, 0.05, z);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        dummy.scale.setScalar(1);
        discMesh.setMatrixAt(i, dummy.matrix);
        discMesh.setColorAt(i, col.setHex(MAP.kia));
      } else {
        // ── 芯の色。**状態で色を置き換えるのは負傷だけ** ──
        //   健常/制圧/担架要員 → 陣営色(制圧は外周リングで示す)
        //   出血中             → 暗い芯(黄の抜き円の中身が空いて見える)
        //   止血済             → 緑の芯(「傷は同じ、処置が済んだ」)
        let coreColor: number;
        if (wounded && showState) coreColor = s.stabilized ? MAP.safe : MAP.shadow;
        else if (wounded) coreColor = MAP.warn; // 遠景では抜き円が潰れるのでベタ黄にする
        else coreColor = SIDE_COLOR[s.side];

        dummy.position.set(x, 0.05, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        discMesh.setMatrixAt(i, dummy.matrix);
        discMesh.setColorAt(i, col.setHex(coreColor));

        // 状態リング: 負傷 = 黄の輪 / 担架要員 = 水色の内リング
        if (showState && (wounded || bearer)) {
          dummy.position.set(x, 0.058, z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          bodyRingMesh.setMatrixAt(bodyN, dummy.matrix);
          bodyRingMesh.setColorAt(bodyN, col.setHex(wounded ? MAP.warn : MAP.live));
          bodyN++;
        }

        // 制圧リング: 陣営色は保ったまま、外周に白い輪を足す(UIレビュー 診断B)
        if (showState && suppressed) {
          dummy.position.set(x, 0.048, z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          haloRingMesh.setMatrixAt(haloN, dummy.matrix);
          haloRingMesh.setColorAt(haloN, col.setHex(MAP.suppress));
          haloN++;
        }

        // 向きのくさび。戦闘可能な兵士だけ、かつ近景でだけ
        if (showWedge && s.status === "ok") {
          dummy.position.set(
            x + Math.sin(heading) * SOLDIER_RADIUS * 0.9,
            0.062,
            z + Math.cos(heading) * SOLDIER_RADIUS * 0.9,
          );
          dummy.rotation.set(0, heading, 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          wedgeMesh.setMatrixAt(wedgeN, dummy.matrix);
          wedgeMesh.setColorAt(
            wedgeN,
            col.setHex(SIDE_COLOR[s.side]).lerp(col2.setHex(0xffffff), 0.3),
          );
          wedgeN++;
        }

        // ── 担架搬送の関係線(UIレビュー 診断C)。運ぶ側から負傷者へ引く ──
        if (bearer && lod !== "far" && litterN < MAX_SOLDIERS) {
          const cas = s.bearing !== null ? interp(s.bearing) : null;
          if (cas) {
            litterPos.setXYZ(2 * litterN, x, 0.07, z);
            litterPos.setXYZ(2 * litterN + 1, cas.x, 0.07, cas.z);
            litterN++;
          }
        }

        // ── 階級章。指揮継承の結果に付く(仕様 §12) ──
        // 中景では小隊長以上だけ残す(UIレビュー「縮尺による間引き」)
        const rank = s.status === "ok"
          ? (rankOf.get(s.id) ?? (s.isFireteamLeader ? RANK_FIRETEAM : RANK_NONE))
          : RANK_NONE;
        const rankVisible =
          showRank && rank !== RANK_NONE && (lod === "near" || rank >= RANK_PLATOON);
        if (rankVisible) {
          const short = TOKEN_R * 2 * BAR_SHORT;
          const long = TOKEN_R * 2 * BAR_LONG;
          if (rank === RANK_FIRETEAM) putBar(x, z, short, 0);
          else if (rank === RANK_SQUAD) {
            putBar(x, z, short, 0);
            putBar(x, z, short, 1);
          } else {
            const bars = rank === RANK_COMPANY ? 3 : 2;
            for (let q = 0; q < bars; q++) putBar(x, z, long, q);
          }
        }
      }

      i++;
    }
    discMesh.count = i;
    soldierShadowMesh.count = i;
    bodyRingMesh.count = bodyN;
    haloRingMesh.count = haloN;
    kiaMesh.count = kiaN;
    wedgeMesh.count = wedgeN;
    rankMesh.count = rankN;
    for (const m of [discMesh, soldierShadowMesh, bodyRingMesh, haloRingMesh, kiaMesh, wedgeMesh, rankMesh]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    litterGeo.setDrawRange(0, litterN * 2);
    litterPos.needsUpdate = true;
    litterLines.visible = litterN > 0;

    // ── 敵 ── 実体ではなく world picture の接触情報を描く(仕様 §5)。
    // 位置は最終目撃位置であって現在位置ではない。確度が下がるほど薄く、
    // 確度0まで落ちた「最終目撃情報」はグレーのゴーストになる。
    let k = 0;
    for (const e of view.enemies) {
      if (k >= MAX_CONTACTS) break;
      const ghost = e.confidence <= 0;

      // 塗りの菱形 + 輪郭。**実体(ベタ塗りの円)と形で描き分ける**(UIレビュー 04)
      dummy.position.set(e.pos.x, 0.045, e.pos.z);
      dummy.rotation.set(0, Math.PI / 4, 0);
      dummy.scale.setScalar(ghost ? 0.75 : 1);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      contactMesh.setMatrixAt(k, dummy.matrix);
      contactEdgeMesh.setMatrixAt(k, dummy.matrix);

      // 確度が高いほど鮮やかに。低いほど背景側へ寄せ、尽きればゴースト色になる
      col.setHex(ghost ? MAP.ghost : SIDE_COLOR[view.enemySide]);
      if (!ghost) col.lerp(col2.setHex(MAP.ghost), 1 - e.confidence);
      contactMesh.setColorAt(k, col);
      contactEdgeMesh.setColorAt(k, col);

      // 不確度円(仕様 §5「時間経過とともに不確度範囲(円)が拡大する」)。
      // **破線**なので、実体でないことが形からも分かる
      const r = Math.max(0.001, e.posError);
      dummy.position.set(e.pos.x, 0.03, e.pos.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(r, 1, r);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      errorRingMesh.setMatrixAt(k, dummy.matrix);
      errorRingMesh.setColorAt(k, col);

      k++;
    }
    contactMesh.count = k;
    contactEdgeMesh.count = k;
    errorRingMesh.count = opts.debug.showContactRings ? k : 0;
    for (const m of [contactMesh, contactEdgeMesh, errorRingMesh]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // ── 操作中 / 選択ユニットのハイライト(指摘: いまどの階層・代表ユニットか) ──
    const ctl = opts.controlledId != null ? interp(opts.controlledId) : null;
    if (ctl) {
      controlRing.position.set(ctl.x, 0.07, ctl.z);
      controlRing.rotation.z += 0.05; // ゆっくり回して目を引く
      controlRing.visible = true;
    } else {
      controlRing.visible = false;
    }
    const sel = opts.selectedId != null ? world.soldierById.get(opts.selectedId) : undefined;
    const selIp = opts.selectedId != null ? interp(opts.selectedId) : null;
    if (selIp) {
      selectRing.position.set(selIp.x, 0.07, selIp.z);
      selectRing.visible = true;
    } else {
      selectRing.visible = false;
    }

    // ── 麾下ユニットの強調(`[v6.4]` 指摘⑤)──
    const scope = sel ? commandScopeOf(world, sel) : null;
    let subN = 0;
    let linkN = 0;
    if (scope && selIp) {
      for (const s of tokens) {
        if (s.id === sel!.id || s.status === "kia") continue;
        if (!scope.covers(s)) continue;
        const ip = interp(s.id);
        if (!ip || subN >= MAX_SOLDIERS) continue;
        dummy.position.set(ip.x, 0.065, ip.z);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        subRingMesh.setMatrixAt(subN, dummy.matrix);
        subN++;
        // 直属の下位指揮官へだけ線を引く。全員へ引くと束になって読めない
        if (scope.directIds.has(s.id) && linkN < MAX_COMMAND_LINKS) {
          linkPos.setXYZ(2 * linkN, selIp.x, 0.06, selIp.z);
          linkPos.setXYZ(2 * linkN + 1, ip.x, 0.06, ip.z);
          linkN++;
        }
      }
    }
    // ── 前線と火力の統制線(`[v6.16]`、`[v6.17]` で折れ線化)──
    //
    // **盤面の事実ではなく指揮官の像。** 報告からしか引いていないので兵士の実際の
    // 位置とずれる — ずれて見えるのが正しい(仕様 §5)。真値で描くと §5 が守られて
    // いることを画面から確認できなくなる。
    //
    // 3種類を重ねる。中隊長の線は小隊3個を結んだ粗い折れ線、その下に各小隊長が
    // 持っている分隊3〜4個ぶんの細かい線が入る。**階層ごとに解像度の違う線が
    // 重なった形**が、指揮官たちが実際に持っている前線像そのもの。
    beginDashes(flotLine);
    beginDashes(flotSubLine);
    beginDashes(fscmLine);
    if (opts.debug.showFlot) {
      const viewCo = world.companies.find((c) => c.side === opts.viewSide) ?? null;
      if (viewCo && viewCo.flot.sources > 0) {
        const pts = viewCo.flot.trace.map((n) => n.pos);
        addPolylineDashes(flotLine, pts, 0.055, FLOT_CO);
        // 統制線は前線を前進方向へ危険近接ぶん押し出したもの。ここより手前へは撃たない
        const len = Math.hypot(viewCo.advanceDir.x, viewCo.advanceDir.z) || 1;
        const ox = (viewCo.advanceDir.x / len) * MORTAR.DANGER_CLOSE;
        const oz = (viewCo.advanceDir.z / len) * MORTAR.DANGER_CLOSE;
        addPolylineDashes(
          fscmLine,
          pts.map((p) => ({ x: p.x + ox, z: p.z + oz })),
          0.05,
          FLOT_CO,
        );
      }
      for (const pl of world.platoons) {
        if (pl.side !== opts.viewSide || pl.flot.sources === 0) continue;
        addPolylineDashes(flotSubLine, pl.flot.trace.map((n) => n.pos), 0.045, FLOT_PL);
      }
    }
    endDashes(flotLine);
    endDashes(flotSubLine);
    endDashes(fscmLine);

    subRingMesh.count = subN;
    subRingMesh.instanceMatrix.needsUpdate = true;
    linkGeo.setDrawRange(0, linkN * 2);
    linkPos.needsUpdate = true;
    linkLines.visible = linkN > 0;

    // ── 配置エディタの計画マーカー(`[v6.4]`)──
    const setup = opts.setup ?? null;
    for (const side of ["blue", "red"] as const) {
      const sp = setup?.spawn[side];
      const mark = spawnMarks[side]!;
      const arrow = spawnArrows[side]!;
      if (!sp) {
        mark.visible = false;
        arrow.visible = false;
        continue;
      }
      const armed =
        (side === "blue" && opts.setupTool === "blueSpawn") ||
        (side === "red" && opts.setupTool === "redSpawn");
      mark.position.set(sp.pos.x, 0.12, sp.pos.z);
      (mark.material as THREE.MeshBasicMaterial).opacity = armed ? 0.95 : 0.5;
      mark.visible = true;
      const len = Math.hypot(sp.facing.x, sp.facing.z) || 1;
      const fx = sp.facing.x / len;
      const fz = sp.facing.z / len;
      arrow.position.set(sp.pos.x + fx * 8.5, 0.12, sp.pos.z + fz * 8.5);
      arrow.rotation.set(0, Math.atan2(fx, fz), 0);
      (arrow.material as THREE.MeshBasicMaterial).opacity = armed ? 0.95 : 0.6;
      arrow.visible = true;
    }
    const planObjs = setup?.objectives ?? null;
    for (let k = 0; k < MAX_SETUP_OBJ; k++) {
      const m = setupObjMarks[k]!;
      const pin = setupObjPins[k]!;
      const o = planObjs ? planObjs[k] : undefined;
      if (!o) {
        m.visible = false;
        pin.visible = false;
        continue;
      }
      const armed = opts.setupTool === "objective";
      m.position.set(o.pos.x, 0.13, o.pos.z);
      m.scale.set(o.radius, 1, o.radius);
      (m.material as THREE.MeshBasicMaterial).opacity = armed ? 0.95 : 0.45;
      m.visible = true;
      pin.position.set(o.pos.x, 0.13, o.pos.z);
      (pin.material as THREE.MeshBasicMaterial).opacity = armed ? 0.95 : 0.5;
      pin.visible = true;
    }

    // ── 作戦の接近経路(`[v6.5]`)──
    // カーソルの乗っている1本だけを濃く、他は薄くする。地図に文字を出さずに
    // 「パネルのこの行が地図のこの矢印」を伝えるための表現。
    const routes = opts.planRoutes ?? null;
    let chevN = 0;
    for (let r = 0; r < MAX_PLAN_ROUTES; r++) {
      const line = planRouteLines[r]!;
      const arrow = planArrows[r]!;
      const rt = routes ? routes[r] : undefined;
      if (!rt || rt.points.length < 2) {
        line.visible = false;
        arrow.visible = false;
        continue;
      }
      const hot = opts.hoveredPlanKey == null || opts.hoveredPlanKey === rt.key;
      const shade = rt.main ? 1 : 0.72;
      col.setHex(SIDE_COLOR[rt.side]).lerp(col2.setHex(0xffffff), rt.main ? 0.3 : 0.05);
      const alpha = hot ? 0.95 * shade : 0.2;
      (line.material as THREE.LineBasicMaterial).color.copy(col);
      (line.material as THREE.LineBasicMaterial).opacity = alpha;
      setPolyline(line, rt.points, 0.16);
      const a = rt.points[rt.points.length - 2]!;
      const b = rt.points[rt.points.length - 1]!;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      // 矢羽根は目標の**手前**で止める。目標の上に置くと、拠点の標(標は矢羽根より
      // 小さい)が矢羽根の内側に隠れて「どこが拠点か」が読めなくなる
      const back = rt.main ? 6.5 : 4.8;
      arrow.position.set(b.x - ((b.x - a.x) / len) * back, 0.16, b.z - ((b.z - a.z) / len) * back);
      arrow.rotation.set(0, Math.atan2((b.x - a.x) / len, (b.z - a.z) / len), 0);
      (arrow.material as THREE.MeshBasicMaterial).color.copy(col);
      (arrow.material as THREE.MeshBasicMaterial).opacity = alpha;
      arrow.scale.setScalar(rt.main ? 1.4 : 1);
      arrow.visible = true;

      // 経路に沿って山形を等間隔で撒く。最後の脚は矢羽根が立つので少し手前で止める
      for (let seg = 0; seg + 1 < rt.points.length; seg++) {
        const p0 = rt.points[seg]!;
        const p1 = rt.points[seg + 1]!;
        const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        const heading = Math.atan2((p1.x - p0.x) / (segLen || 1), (p1.z - p0.z) / (segLen || 1));
        for (let d = CHEVRON_SPACING; d < segLen - 4; d += CHEVRON_SPACING) {
          if (chevN >= MAX_CHEVRONS) break;
          const t = d / segLen;
          dummy.position.set(p0.x + (p1.x - p0.x) * t, 0.155, p0.z + (p1.z - p0.z) * t);
          dummy.rotation.set(0, heading, 0);
          dummy.scale.setScalar(rt.main ? 1.15 : 0.9);
          dummy.updateMatrix();
          dummy.scale.setScalar(1);
          chevronMesh.setMatrixAt(chevN, dummy.matrix);
          chevronMesh.setColorAt(chevN, col2.copy(col).multiplyScalar(alpha));
          chevN++;
        }
      }
    }
    chevronMesh.count = chevN;
    chevronMesh.instanceMatrix.needsUpdate = true;
    if (chevronMesh.instanceColor) chevronMesh.instanceColor.needsUpdate = true;

    // ── 移動命令の可視化(指摘: 移動命令が出せているか分からない) ──
    const obj = opts.debug.showOrders ? controlObjective() : null;
    if (obj && ctl) {
      orderMarker.position.set(obj.x, 0.04, obj.z);
      orderMarker.rotation.z += 0.03;
      orderMarker.visible = true;
      setPolyline(orderLine, [{ x: ctl.x, z: ctl.z }, obj], 0.08);
    } else {
      orderMarker.visible = false;
      orderLine.visible = false;
    }
    // 操作中ユニットの計画経路
    const ctlSoldier = opts.controlledId != null ? world.soldierById.get(opts.controlledId) : undefined;
    if (opts.debug.showOrders && ctlSoldier && ctlSoldier.path.length >= 2 && ctl) {
      setPolyline(
        controlPathLine,
        [{ x: ctl.x, z: ctl.z }, ...ctlSoldier.path.slice(ctlSoldier.pathIdx)],
        0.07,
      );
    } else {
      controlPathLine.visible = false;
    }
    // 選択ユニットの計画経路(デバッグ)
    if (opts.debug.showPaths && sel && sel.path.length >= 2 && selIp) {
      setPolyline(selectPathLine, [{ x: selIp.x, z: selIp.z }, ...sel.path.slice(sel.pathIdx)], 0.07);
    } else {
      selectPathLine.visible = false;
    }

    // ── 発砲線 / 擲弾の着弾円(指摘: 撃った線 / 榴弾を可視化) ──
    if (world.tick !== lastFxTick) {
      for (const f of world.fx) {
        if (f.kind === "shot") {
          if (tracers.length < MAX_TRACERS)
            tracers.push({ fx: f.from.x, fz: f.from.z, tx: f.to.x, tz: f.to.z, hit: f.hit, life: TRACER_LIFE });
        } else if (blasts.length < MAX_BLASTS) {
          const mortar = f.kind === "mortar";
          blasts.push({
            x: f.at.x,
            z: f.at.z,
            radius: f.radius,
            side: f.side,
            life: mortar ? MORTAR_BLAST_LIFE : BLAST_LIFE,
            mortar,
            suppressRadius: f.kind === "mortar" ? f.suppressRadius : f.radius,
          });
          // 迫撃砲だけ破片を飛ばす。擲弾にも付けると盤面が線だらけになり、
          // 「これは別格の出来事だ」という区別が消える
          if (mortar) {
            for (let k = 0; k < DEBRIS_PER_BLAST && debris.length < MAX_DEBRIS; k++) {
              const a = debrisRand() * Math.PI * 2;
              debris.push({
                x: f.at.x,
                z: f.at.z,
                dx: Math.cos(a),
                dz: Math.sin(a),
                len: f.radius * (0.9 + debrisRand() * 1.6),
                life: DEBRIS_LIFE * (0.6 + debrisRand() * 0.4),
              });
            }
          }
        }
      }
      lastFxTick = world.tick;
    }
    for (const t of tracers) t.life -= dt;
    for (const b of blasts) b.life -= dt;
    for (const d of debris) d.life -= dt;
    tracers = tracers.filter((t) => t.life > 0);
    blasts = blasts.filter((b) => b.life > 0);
    debris = debris.filter((d) => d.life > 0);

    const nT = Math.min(tracers.length, MAX_TRACERS);
    for (let j = 0; j < nT; j++) {
      const t = tracers[j]!;
      const fade = Math.max(0, t.life / TRACER_LIFE);
      tracerPos.setXYZ(2 * j, t.fx, 0.5, t.fz);
      tracerPos.setXYZ(2 * j + 1, t.tx, 0.5, t.tz);
      col.setHex(t.hit ? TRACER_HIT_COLOR : TRACER_MISS_COLOR).multiplyScalar(0.35 + 0.65 * fade);
      tracerColArr.setXYZ(2 * j, col.r, col.g, col.b);
      tracerColArr.setXYZ(2 * j + 1, col.r, col.g, col.b);
    }
    tracerGeo.setDrawRange(0, nT * 2);
    tracerPos.needsUpdate = true;
    tracerColArr.needsUpdate = true;
    tracerMesh.visible = opts.debug.showShotLines && nT > 0;

    // ── 迫撃砲の着弾(`[v6.9]`)── 火球 → 衝撃波 → 土煙 の3層
    const mortarBlasts = blasts.filter((b) => b.mortar);
    for (let j = 0; j < MAX_BLASTS; j++) {
      const slot = mortarPool[j]!;
      const b = j < mortarBlasts.length ? mortarBlasts[j]! : null;
      if (!b) {
        slot.core.visible = false;
        slot.shock.visible = false;
        slot.dust.visible = false;
        continue;
      }
      const frac = 1 - Math.max(0, b.life / MORTAR_BLAST_LIFE); // 0(着弾)→1(消滅)
      // 火球: 一瞬で最大になり、すぐ落ちる(前半0.25で消える)
      const coreT = Math.min(1, frac / 0.25);
      const coreR = b.radius * (0.5 + 0.5 * coreT);
      slot.core.position.set(b.x, 0.09, b.z);
      slot.core.scale.set(coreR, 1, coreR);
      (slot.core.material as THREE.MeshBasicMaterial).color.setHex(MAP.blastCore);
      (slot.core.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - coreT);
      slot.core.visible = coreT < 1;
      // 衝撃波: 殺傷半径まで一気に広がる
      const shockT = Math.min(1, frac / 0.45);
      const shockR = b.radius * (0.3 + 0.85 * shockT);
      slot.shock.position.set(b.x, 0.08, b.z);
      slot.shock.scale.set(shockR, 1, shockR);
      (slot.shock.material as THREE.MeshBasicMaterial).color.setHex(MAP.blastShock);
      (slot.shock.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - shockT);
      slot.shock.visible = shockT < 1;
      // 土煙: ゆっくり制圧半径まで広がって薄れる。この円の中が制圧の範囲(仕様 §8.6)
      const dustR = b.suppressRadius * (0.35 + 0.65 * frac);
      slot.dust.position.set(b.x, 0.07, b.z);
      slot.dust.scale.set(dustR, 1, dustR);
      (slot.dust.material as THREE.MeshBasicMaterial).color.setHex(MAP.blastDust);
      (slot.dust.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - frac);
      slot.dust.visible = true;
    }

    // ── 破片の飛散線(`[v6.9]`)──
    const nD = Math.min(debris.length, MAX_DEBRIS);
    for (let j = 0; j < nD; j++) {
      const d = debris[j]!;
      const t = 1 - Math.max(0, d.life / DEBRIS_LIFE);
      // 内側の端も外へ動かして「飛んでいる線分」に見せる
      const tail = d.len * t * 0.85;
      const head = d.len * Math.min(1, t * 1.6);
      debrisPos.setXYZ(2 * j, d.x + d.dx * tail, 0.55, d.z + d.dz * tail);
      debrisPos.setXYZ(2 * j + 1, d.x + d.dx * head, 0.55, d.z + d.dz * head);
      col.setHex(MAP.blastShock).multiplyScalar(1 - t);
      debrisCol.setXYZ(2 * j, col.r, col.g, col.b);
      debrisCol.setXYZ(2 * j + 1, col.r, col.g, col.b);
    }
    debrisGeo.setDrawRange(0, nD * 2);
    debrisPos.needsUpdate = true;
    debrisCol.needsUpdate = true;
    debrisMesh.visible = nD > 0;

    // ── 着弾前の警告リング(`[v6.9]`)── 縮んでいくリングで「あと何秒」を示す
    for (let j = 0; j < MAX_INCOMING; j++) {
      const slot = incomingPool[j]!;
      const m = world.fireMissions[j];
      if (!m) {
        slot.ring.visible = false;
        slot.cross.visible = false;
        continue;
      }
      const remain = Math.max(0, m.nextImpactTick - world.tick) / SIM_HZ;
      // 5秒前から出す。それ以前に出すと盤面に警告が居座って読みにくい
      if (remain > 5) {
        slot.ring.visible = false;
        slot.cross.visible = false;
        continue;
      }
      const t = 1 - remain / 5; // 0(遠い)→1(着弾直前)
      const r = 26 * (1 - t) + 7 * t;
      const c = m.side === "blue" ? MAP.blue : MAP.red;
      // 着弾が近いほど速く明滅する
      const pulse = 0.45 + 0.55 * Math.abs(Math.sin((nowMs / 1000) * (3 + 9 * t) * Math.PI));
      slot.ring.position.set(m.target.x, 0.1, m.target.z);
      slot.ring.scale.set(r, 1, r);
      (slot.ring.material as THREE.MeshBasicMaterial).color.setHex(c);
      (slot.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * pulse;
      slot.ring.visible = true;
      slot.cross.position.set(m.target.x, 0.1, m.target.z);
      slot.cross.scale.set(r * 0.4, 1, r * 0.4);
      (slot.cross.material as THREE.LineBasicMaterial).color.setHex(c);
      (slot.cross.material as THREE.LineBasicMaterial).opacity = 0.9 * pulse;
      slot.cross.visible = true;
    }

    const grenadeBlasts = blasts.filter((b) => !b.mortar);
    for (let j = 0; j < MAX_BLASTS; j++) {
      const slot = blastPool[j]!;
      const b = j < grenadeBlasts.length ? grenadeBlasts[j]! : null;
      if (!b) {
        slot.fill.visible = false;
        slot.ring.visible = false;
        continue;
      }
      const frac = 1 - Math.max(0, b.life / BLAST_LIFE); // 0(着弾)→1(消滅)
      const fillR = b.radius * (0.35 + 0.65 * frac);
      const ringR = b.radius * (0.45 + 0.95 * frac);
      slot.fill.position.set(b.x, 0.05, b.z);
      slot.ring.position.set(b.x, 0.06, b.z);
      slot.fill.scale.set(fillR, 1, fillR);
      slot.ring.scale.set(ringR, 1, ringR);
      (slot.fill.material as THREE.MeshBasicMaterial).color.setHex(0xffb648);
      (slot.ring.material as THREE.MeshBasicMaterial).color.setHex(0xffd27a);
      (slot.fill.material as THREE.MeshBasicMaterial).opacity = 0.42 * (1 - frac);
      (slot.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - frac);
      slot.fill.visible = true;
      slot.ring.visible = true;
    }

    // ── デバッグ: 視界扇形(FOV) ──
    if (world.tuning.fovHalfRad !== coneHalf || world.tuning.detectRange !== coneRange) {
      coneHalf = world.tuning.fovHalfRad;
      coneRange = world.tuning.detectRange;
      const ng = buildConeGeo(coneHalf, coneRange);
      coneGeo.dispose();
      coneGeo = ng;
      fovMesh.geometry = ng;
    }
    let fc = 0;
    if (opts.debug.fov !== "off") {
      const fovSet: Soldier[] =
        opts.debug.fov === "selected"
          ? sel && sel.status === "ok"
            ? [sel]
            : []
          : opts.debug.fov === "side"
            ? view.friendly
            : view.friendly.concat(view.enemiesTruth);
      for (const s of fovSet) {
        if (fc >= MAX_SOLDIERS) break;
        if (s.status !== "ok") continue;
        const ip = interp(s.id);
        if (!ip) continue;
        dummy.position.set(ip.x, 0.02, ip.z);
        dummy.rotation.set(0, ip.heading, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        fovMesh.setMatrixAt(fc, dummy.matrix);
        fovMesh.setColorAt(fc, col.setHex(SIDE_COLOR[s.side]));
        fc++;
      }
    }
    fovMesh.count = fc;
    fovMesh.instanceMatrix.needsUpdate = true;
    if (fovMesh.instanceColor) fovMesh.instanceColor.needsUpdate = true;

    // ── デバッグ: 隠蔽率カラーグリッド(選択ユニット視点の視認可否 × 地形カバー) ──
    if (opts.debug.showConcealment && sel && selIp) {
      // 選択・向き・tuning・数ティックごとにだけ組み直す(LOSレイキャストが重いため)
      const key = `${sel.id}|${world.tick >> 2}|${coneHalf.toFixed(3)}|${coneRange}`;
      if (key !== gridKey) {
        gridKey = key;
        const cos = Math.cos(coneHalf);
        const eyeX = sel.eye.x;
        const eyeZ = sel.eye.z;
        const fdx = Math.sin(selIp.heading);
        const fdz = Math.cos(selIp.heading);
        let g = 0;
        for (let gx = world.bounds.minX + GRID_CELL / 2; gx < world.bounds.maxX; gx += GRID_CELL) {
          for (let gz = world.bounds.minZ + GRID_CELL / 2; gz < world.bounds.maxZ; gz += GRID_CELL) {
            if (g >= MAX_GRID_CELLS) break;
            if (collidesWall(world.walls, gx, gz, 0.1)) continue;
            const dx = gx - eyeX;
            const dz = gz - eyeZ;
            const d = Math.hypot(dx, dz) || 1e-6;
            const visible =
              d <= coneRange &&
              (fdx * dx + fdz * dz) / d >= cos &&
              hasLineOfSight(world.walls, eyeX, eyeZ, gx, gz);
            const cover = coverBonus(world.walls, gx, gz) / 2.4; // 0..1
            // 露出(赤)↔ 隠蔽(緑)。壁際は LOS が通っていても緑側へ寄せる。
            if (visible) col.setRGB(0.95, 0.3, 0.22);
            else col.setRGB(0.2, 0.78, 0.4);
            col.lerp(col2.setRGB(0.15, 0.6, 0.35), cover * 0.55);
            dummy.position.set(gx, 0.012, gz);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.setScalar(1);
            dummy.updateMatrix();
            gridMesh.setMatrixAt(g, dummy.matrix);
            gridMesh.setColorAt(g, col);
            g++;
          }
        }
        gridMesh.count = g;
        gridMesh.instanceMatrix.needsUpdate = true;
        if (gridMesh.instanceColor) gridMesh.instanceColor.needsUpdate = true;
      }
    } else if (gridMesh.count !== 0) {
      gridMesh.count = 0;
      gridKey = "";
    }

    renderer.render(scene, camera);
  }

  function screenToWorld(clientX: number, clientY: number): { x: number; z: number } {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const halfH = viewSpan / 2;
    const halfW = halfH * (rect.width / Math.max(1, rect.height));
    return { x: target.x + ndcX * halfW, z: target.z - ndcY * halfH };
  }

  // ── カメラ操作: ドラッグでパン、ホイール/ピンチでズーム ──
  //
  // `[v6.18]` **指2本のピンチを足した。** ポインタは PointerEvent で受けているので
  // マウスもタッチも同じ経路を通る。2本目が触れているあいだはパンを止め、
  // 2本の間隔の比でズームする(指を離すと、残った1本を新しい基準にしてパンへ戻る)。
  const active = new Map<number, { x: number; y: number }>();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  /** ピンチ中の直前の指の間隔。0 ならピンチしていない */
  let pinchDist = 0;

  const twoPointers = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
    if (active.size !== 2) return null;
    const [a, b] = [...active.values()];
    return [a!, b!];
  };

  const onDown = (e: PointerEvent) => {
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    const two = twoPointers();
    if (two) {
      // 2本目が触れた瞬間にパンをやめる。やらないと拡縮しながら盤面が飛ぶ
      dragging = false;
      pinchDist = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
      return;
    }
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };

  const onMove = (e: PointerEvent) => {
    if (active.has(e.pointerId)) active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const two = twoPointers();
    if (two) {
      const d = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
      if (pinchDist > 1 && d > 1) {
        viewSpan = THREE.MathUtils.clamp(viewSpan * (pinchDist / d), 12, 220);
        updateCamera();
      }
      pinchDist = d;
      return;
    }
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const perPxY = viewSpan / rect.height;
    target.x -= (e.clientX - lastX) * perPxY;
    target.z -= (e.clientY - lastY) * perPxY;
    lastX = e.clientX;
    lastY = e.clientY;
    updateCamera();
  };

  const onUp = (e: PointerEvent) => {
    active.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    pinchDist = 0;
    // 指が1本残っていれば、そこを基準にパンを続ける(指を1本離した瞬間に飛ばない)
    const rest = [...active.entries()][0];
    if (rest) {
      dragging = true;
      lastX = rest[1].x;
      lastY = rest[1].y;
    } else {
      dragging = false;
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    viewSpan = THREE.MathUtils.clamp(viewSpan * (e.deltaY > 0 ? 1.1 : 0.9), 12, 220);
    updateCamera();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  resize();

  return {
    render,
    resize,
    screenToWorld,
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      // 起動時に作った静的ジオメトリ・マテリアル(地面・影・壁・床・拠点)`[v6.5]`。
      // シナリオ切替と配置適用のたびにレンダラごと作り直すので、ここを怠ると
      // 遊んでいる間ずっとGPUメモリが積み上がる
      for (const g of staticGeos) g.dispose();
      for (const m of staticMats) m.dispose();
      groundTex.dispose();
      for (const l of planRouteLines) {
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
      for (const a of planArrows) {
        a.geometry.dispose();
        (a.material as THREE.Material).dispose();
      }
      chevronGeo.dispose();
      chevronMesh.dispose();
      for (const g of [
        soldierShadowGeo,
        discGeo,
        bodyRingGeo,
        haloRingGeo,
        kiaGeo,
        wedgeGeo,
        rankGeo,
        contactGeo,
        contactEdgeGeo,
        errorRingGeo,
      ]) {
        g.dispose();
      }
      for (const m of [
        soldierShadowMesh,
        discMesh,
        bodyRingMesh,
        haloRingMesh,
        kiaMesh,
        wedgeMesh,
        rankMesh,
        contactMesh,
        contactEdgeMesh,
        errorRingMesh,
      ]) {
        m.dispose();
      }
      litterGeo.dispose();
      (litterLines.material as THREE.Material).dispose();
      controlRing.geometry.dispose();
      selectRing.geometry.dispose();
      subRingGeo.dispose();
      subRingMesh.dispose();
      for (const m of [spawnMarks.blue, spawnMarks.red, spawnArrows.blue, spawnArrows.red, ...setupObjMarks, ...setupObjPins]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      flotLine.geo.dispose();
      (flotLine.line.material as THREE.Material).dispose();
      flotSubLine.geo.dispose();
      (flotSubLine.line.material as THREE.Material).dispose();
      fscmLine.geo.dispose();
      (fscmLine.line.material as THREE.Material).dispose();
      linkGeo.dispose();
      (linkLines.material as THREE.Material).dispose();
      orderMarkerGeo.dispose();
      orderLine.geometry.dispose();
      controlPathLine.geometry.dispose();
      selectPathLine.geometry.dispose();
      tracerGeo.dispose();
      (tracerMesh.material as THREE.Material).dispose();
      for (const b of blastPool) {
        b.fill.geometry.dispose();
        b.ring.geometry.dispose();
      }
      coneGeo.dispose();
      fovMesh.dispose();
      cellGeo.dispose();
      gridMesh.dispose();
      renderer.dispose();
    },
  };
}
