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
import { LITTER, SOLDIER_RADIUS } from "@sim/constants.ts";
import { collidesWall, hasLineOfSight } from "@sim/geometry.ts";
import { coverBonus } from "@sim/cover.ts";

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
  };
  /** クリック選択した兵士(デバッグ表示の基準) */
  selectedId: number | null;
  /** 人間が操作中のノードの身体(仕様 §4) */
  controlledId: number | null;
  /** いま見ている陣営 */
  viewSide: Side;
  /** 神視点か(敵も向き付きトークンで描く) */
  truth: boolean;
}

const SIDE_COLOR: Record<Side, number> = {
  blue: 0x4aa3ff,
  red: 0xff5a4a,
};
const KIA_COLOR = 0x39414f;
const WIA_COLOR = 0xf0c000;
const GROUND_COLOR = 0x0f1420;
const WALL_COLOR = 0x39435a;
/** 建物の床。屋外と区別がつく程度に明るくする(仕様 §7.1) */
const ROOM_FLOOR_COLOR = 0x1a2233;
/** 閉じた扉 — 視線も移動も遮っている(仕様 §7.6) */
const DOOR_CLOSED_COLOR = 0xc98a3a;
/** 開いた扉 — この瞬間から室内が見える(仕様 §7.6) */
const DOOR_OPEN_COLOR = 0x3f6b52;
/** 中立の拠点(仕様 §12) */
const NEUTRAL_OBJ_COLOR = 0x6de0a0;
/** コンテスト状態 — 確保カウントが完全に停止している(仕様 §12) */
const CONTESTED_OBJ_COLOR = 0xf5c451;
/** 確度が尽きた最終目撃情報(ゴースト)の色。仕様 §5 `[v6]` */
const GHOST_COLOR = 0x6b7280;
/** 人間が操作中のノードを囲むリング(指摘: いまどのユニットを操作しているか分からない) */
const CONTROL_RING_COLOR = 0xf5d84a;
/** クリック選択した兵士を囲むリング(デバッグ表示の基準) */
const SELECT_RING_COLOR = 0x7ff0ff;
/** 発砲線: 命中 / 外れ */
const TRACER_HIT_COLOR = 0xffe08a;
const TRACER_MISS_COLOR = 0x8a939c;
/** 発砲線の寿命(秒)。短く光ってすぐ消える */
const TRACER_LIFE = 0.11;
/** 擲弾の着弾円の寿命(秒) */
const BLAST_LIFE = 0.55;
const MAX_TRACERS = 400;
const MAX_BLASTS = 24;
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
}
/** 止血済みWIA。出血は止まったが行動不能で後送待ち(仕様 §9) */
const STABILIZED_COLOR = 0x4fb477;
/** 担架搬送中(負傷者本人と担架要員の両方)。仕様 §9 */
const CARRYING_COLOR = 0x8fd6ff;
const MAX_SOLDIERS = 512;
const MAX_CONTACTS = 512;

/**
 * 階級章(`[v6.2]` 初回テストプレイ指摘「陣営ユニットの階級別の表示がわかりにくい」)。
 *
 * トークンの上に NATO 風の小さな標を置く。階級は肩書きではなく**指揮継承の結果**
 * (`commanderId`)から引くので、分隊長が倒れて次席が引き継げば標もそちらへ移る(仕様 §12)。
 *
 * 一般兵 = 無印 / FTリーダー = 点1 / 分隊長 = 点2 / 小隊長 = 棒1 / 中隊長 = 棒2
 */
const RANK_NONE = 0;
const RANK_FIRETEAM = 1;
const RANK_SQUAD = 2;
const RANK_PLATOON = 3;
const RANK_COMPANY = 4;
/** 点(pip)の一辺 m と横の間隔 m */
const PIP_SIZE = 0.26;
const PIP_GAP = 0.36;
/** 棒(bar)の寸法 m と縦の間隔 m */
const BAR_W = 0.95;
const BAR_H = 0.17;
const BAR_GAP = 0.3;
/** トークン中心から階級章までの距離 m(画面上では上方向 = −Z) */
const RANK_OFFSET = SOLDIER_RADIUS * 2.4;
/** 階級章1個ぶんのインスタンス上限(兵士1名あたり最大2個) */
const MAX_RANK_MARKS = MAX_SOLDIERS * 2;

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
  scene.background = new THREE.Color(GROUND_COLOR);

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

  // 地面
  const groundW = world.bounds.maxX - world.bounds.minX;
  const groundH = world.bounds.maxZ - world.bounds.minZ;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundW, groundH),
    new THREE.MeshBasicMaterial({ color: GROUND_COLOR }),
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
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(groundW, groundH)),
    new THREE.LineBasicMaterial({ color: 0x2a3446 }),
  );
  border.rotation.x = -Math.PI / 2;
  border.position.copy(ground.position);
  scene.add(border);

  // 建物の床(仕様 §7.1: 屋外と屋内はシームレスな1つのマップ)。
  // 壁より先に描いて、部屋の広がりが分かるようにする
  for (const b of world.buildings) {
    for (const r of b.rooms) {
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(r.bounds.maxX - r.bounds.minX, r.bounds.maxZ - r.bounds.minZ),
        new THREE.MeshBasicMaterial({ color: ROOM_FLOOR_COLOR }),
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

  // 壁 — 数が少ないので個別メッシュで足りる。
  // world.walls は扉の開閉で変化するので、**構造物の壁だけ**を描く
  const wallMat = new THREE.MeshBasicMaterial({ color: WALL_COLOR });
  for (const w of world.structuralWalls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.hw * 2, 2, w.hd * 2), wallMat);
    m.position.set(w.cx, 1, w.cz);
    scene.add(m);
  }

  // 扉(仕様 §7.6): 開閉が視界の境界線になるので、状態が一目で分かるようにする
  const doorMeshes = world.doors.map((d) => {
    const alongX = Math.abs(d.normal.x) > Math.abs(d.normal.z);
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(alongX ? 0.35 : d.width, 1.8, alongX ? d.width : 0.35),
      new THREE.MeshBasicMaterial({ color: DOOR_CLOSED_COLOR }),
    );
    m.position.set(d.pos.x, 0.9, d.pos.z);
    scene.add(m);
    return m;
  });

  // 拠点(仕様 §12)。所有と確保進捗が一目で分かるよう、外周リングと進捗リングを分ける
  const objectiveRings = world.objectives.map((o) => {
    const outer = new THREE.Mesh(
      new THREE.RingGeometry(o.radius - 0.4, o.radius, 48),
      new THREE.MeshBasicMaterial({
        color: NEUTRAL_OBJ_COLOR,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(o.pos.x, 0.02, o.pos.z);
    scene.add(outer);

    // 進捗は内側の円盤の大きさで示す(0 で消え、1 で外周に届く)
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({
        color: NEUTRAL_OBJ_COLOR,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
      }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(o.pos.x, 0.015, o.pos.z);
    scene.add(fill);
    return { outer, fill };
  });

  // 負傷者集合点(CCP、仕様 §9)。担架班の搬送先なので、常に両陣営分を描く。
  for (const side of ["blue", "red"] as Side[]) {
    const p = world.ccp[side];
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(LITTER.EVAC_RADIUS - 0.35, LITTER.EVAC_RADIUS, 32),
      new THREE.MeshBasicMaterial({
        color: SIDE_COLOR[side],
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.02, p.z);
    scene.add(ring);
    // CCPだと分かるよう十字を重ねる(衛生標識の見立て)
    const cross = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
    );
    cross.rotation.x = -Math.PI / 2;
    cross.position.set(p.x, 0.021, p.z);
    scene.add(cross);
    const cross2 = cross.clone();
    cross2.rotation.z = Math.PI / 2;
    scene.add(cross2);
  }

  // 兵士 — インスタンス化した円盤 + 向きを示すくさび形
  const discGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 1.6, 16);
  discGeo.rotateX(-Math.PI / 2);
  const discMesh = new THREE.InstancedMesh(
    discGeo,
    new THREE.MeshBasicMaterial(),
    MAX_SOLDIERS,
  );
  discMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SOLDIERS * 3), 3);
  scene.add(discMesh);

  // 向きを示すくさび形。指摘に合わせて小さくし(2.4→1.5)、色は陣営色にする
  // (以前は全兵士が近白の固定色で、プレイヤーの向き三角に見えていた)。
  const wedgeGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 1.5, 3);
  wedgeGeo.rotateX(-Math.PI / 2);
  const wedgeMesh = new THREE.InstancedMesh(
    wedgeGeo,
    new THREE.MeshBasicMaterial(),
    MAX_SOLDIERS,
  );
  wedgeMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_SOLDIERS * 3),
    3,
  );
  scene.add(wedgeMesh);

  // 階級章(`[v6.2]`)。単位平面を1枚だけ用意し、点は正方形・棒は横長にスケールする。
  const rankGeo = new THREE.PlaneGeometry(1, 1);
  rankGeo.rotateX(-Math.PI / 2);
  const rankMesh = new THREE.InstancedMesh(
    rankGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false }),
    MAX_RANK_MARKS,
  );
  rankMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_RANK_MARKS * 3),
    3,
  );
  rankMesh.renderOrder = 12;
  rankMesh.frustumCulled = false;
  scene.add(rankMesh);

  // 敵接触マーカー — 実体ではなく「報告された最終目撃位置」を描く(仕様 §5)。
  // 味方の円盤と明確に見分けがつくよう、菱形(4分割の円)で表現する。
  const contactGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 2.0, 4);
  contactGeo.rotateX(-Math.PI / 2);
  const contactMesh = new THREE.InstancedMesh(
    contactGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }),
    MAX_CONTACTS,
  );
  contactMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_CONTACTS * 3),
    3,
  );
  scene.add(contactMesh);

  // 不確度円 — 時間経過とともに拡大する(仕様 §5)。リング状の線で描く。
  const errorRingGeo = new THREE.RingGeometry(0.97, 1.0, 32);
  errorRingGeo.rotateX(-Math.PI / 2);
  const errorRingMesh = new THREE.InstancedMesh(
    errorRingGeo,
    // 多数の円が重なるので、1本1本はごく薄くする。密度そのものが不確かさの表現になる。
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.14, side: THREE.DoubleSide }),
    MAX_CONTACTS,
  );
  errorRingMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_CONTACTS * 3),
    3,
  );
  scene.add(errorRingMesh);

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
  const controlRing = makeHiRing(CONTROL_RING_COLOR, 40, 2.4, 3.0);
  const selectRing = makeHiRing(SELECT_RING_COLOR, 4, 2.7, 3.3);

  // ── 移動命令の可視化(指摘: 移動命令が出せているか分からない) ──
  const orderMarkerGeo = new THREE.RingGeometry(0.7, 1.05, 4);
  orderMarkerGeo.rotateX(-Math.PI / 2);
  const orderMarker = new THREE.Mesh(
    orderMarkerGeo,
    new THREE.MeshBasicMaterial({
      color: CONTROL_RING_COLOR,
      transparent: true,
      opacity: 0.9,
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
  const orderLine = makePolyline(CONTROL_RING_COLOR, 0.7); // 操作中ユニット → 目的地
  const controlPathLine = makePolyline(CONTROL_RING_COLOR, 0.5); // 操作中ユニットの計画経路
  const selectPathLine = makePolyline(SELECT_RING_COLOR, 0.7); // 選択ユニットの計画経路

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
      mat.color.setHex(d.open ? DOOR_OPEN_COLOR : DOOR_CLOSED_COLOR);
      m.scale.y = d.open ? 0.12 : 1;
    });

    // 拠点の所有と確保進捗(仕様 §12)
    world.objectives.forEach((o, i) => {
      const r = objectiveRings[i];
      if (!r) return;
      const owner = o.owner ?? o.progressBy;
      const color = o.contested
        ? CONTESTED_OBJ_COLOR
        : owner
          ? SIDE_COLOR[owner]
          : NEUTRAL_OBJ_COLOR;
      (r.outer.material as THREE.MeshBasicMaterial).color.setHex(color);
      (r.fill.material as THREE.MeshBasicMaterial).color.setHex(color);
      const s = Math.max(0.001, o.progress * o.radius);
      r.fill.scale.set(s, 1, s);
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

    let rankN = 0;
    /** 階級章を1個置く。`w`/`h` は m、`dz` はトークンからの上方向オフセット */
    const putMark = (
      x: number,
      z: number,
      dx: number,
      dz: number,
      w: number,
      h: number,
      hex: number,
    ): void => {
      if (rankN >= MAX_RANK_MARKS) return;
      dummy.position.set(x + dx, 0.11, z - RANK_OFFSET - dz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(w, 1, h);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      rankMesh.setMatrixAt(rankN, dummy.matrix);
      rankMesh.setColorAt(rankN, col.setHex(hex));
      rankN++;
    };

    let i = 0;
    for (const s of tokens) {
      const p = prev.pos.get(s.id) ?? cur.pos.get(s.id)!;
      const c = cur.pos.get(s.id) ?? p;
      const x = p.x + (c.x - p.x) * a;
      const z = p.z + (c.z - p.z) * a;
      const fx = p.fx + (c.fx - p.fx) * a;
      const fz = p.fz + (c.fz - p.fz) * a;
      const heading = Math.atan2(fx, fz);

      const dead = s.status === "kia";
      dummy.position.set(x, dead ? 0.02 : 0.05, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(dead ? 0.7 : 1);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      discMesh.setMatrixAt(i, dummy.matrix);

      let color =
        s.status === "kia"
          ? KIA_COLOR
          : s.status === "wia"
            ? s.evac === "carrying"
              ? CARRYING_COLOR // 担架搬送中(仕様 §9)
              : s.stabilized
                ? STABILIZED_COLOR // 止血済み: 出血は止まり後送待ち(仕様 §9)
                : WIA_COLOR // 出血中: 45秒以内に手当がなければKIAへ
            : s.bearing !== null
              ? CARRYING_COLOR // 担架要員: 搬送に専念していて射撃できない
              : SIDE_COLOR[s.side];
      if (s.status === "ok" && s.suppressedUntilTick > world.tick) {
        color = col.setHex(color).lerp(col2.setHex(0xe8edf5), 0.55).getHex();
      }
      discMesh.setColorAt(i, col.setHex(color));

      // 向きのくさび形は、まだ戦闘可能な兵士にのみ表示する。色は陣営色(指摘)。
      const wedgeScale = s.status === "ok" ? 1 : 0.001;
      dummy.position.set(
        x + Math.sin(heading) * SOLDIER_RADIUS * 0.9,
        0.06,
        z + Math.cos(heading) * SOLDIER_RADIUS * 0.9,
      );
      dummy.rotation.set(0, heading, 0);
      dummy.scale.setScalar(wedgeScale);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      wedgeMesh.setMatrixAt(i, dummy.matrix);
      wedgeMesh.setColorAt(i, col.setHex(SIDE_COLOR[s.side]));

      // ── 階級章(`[v6.2]`)。戦闘可能な指揮官にのみ。陣営色を明るく振って、
      // どちらの軍かを保ったまま地の色から浮かせる。
      const rank = s.status === "ok"
        ? (rankOf.get(s.id) ?? (s.isFireteamLeader ? RANK_FIRETEAM : RANK_NONE))
        : RANK_NONE;
      if (rank !== RANK_NONE) {
        const hex = col2.setHex(SIDE_COLOR[s.side]).lerp(col.setHex(0xffffff), 0.6).getHex();
        if (rank === RANK_FIRETEAM || rank === RANK_SQUAD) {
          const pips = rank === RANK_SQUAD ? 2 : 1;
          for (let q = 0; q < pips; q++) {
            const dx = (q - (pips - 1) / 2) * PIP_GAP;
            putMark(x, z, dx, 0, PIP_SIZE, PIP_SIZE, hex);
          }
        } else {
          const bars = rank === RANK_COMPANY ? 2 : 1;
          for (let q = 0; q < bars; q++) putMark(x, z, 0, q * BAR_GAP, BAR_W, BAR_H, hex);
        }
      }

      i++;
    }
    discMesh.count = i;
    wedgeMesh.count = i;
    rankMesh.count = rankN;
    discMesh.instanceMatrix.needsUpdate = true;
    wedgeMesh.instanceMatrix.needsUpdate = true;
    rankMesh.instanceMatrix.needsUpdate = true;
    if (discMesh.instanceColor) discMesh.instanceColor.needsUpdate = true;
    if (wedgeMesh.instanceColor) wedgeMesh.instanceColor.needsUpdate = true;
    if (rankMesh.instanceColor) rankMesh.instanceColor.needsUpdate = true;

    // ── 敵 ── 実体ではなく world picture の接触情報を描く(仕様 §5)。
    // 位置は最終目撃位置であって現在位置ではない。確度が下がるほど薄く、
    // 確度0まで落ちた「最終目撃情報」はグレーのゴーストになる。
    let k = 0;
    for (const e of view.enemies) {
      if (k >= MAX_CONTACTS) break;
      const ghost = e.confidence <= 0;

      dummy.position.set(e.pos.x, 0.045, e.pos.z);
      dummy.rotation.set(0, Math.PI / 4, 0);
      dummy.scale.setScalar(ghost ? 0.75 : 1);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      contactMesh.setMatrixAt(k, dummy.matrix);

      if (ghost) {
        contactMesh.setColorAt(k, col.setHex(GHOST_COLOR));
      } else {
        // 確度が高いほど鮮やかに。低いほど背景側へ寄せる。
        col.setHex(SIDE_COLOR[view.enemySide]);
        col2.setHex(GHOST_COLOR);
        contactMesh.setColorAt(k, col.lerp(col2, 1 - e.confidence));
      }

      // 不確度円(仕様 §5「時間経過とともに不確度範囲(円)が拡大する」)
      const r = Math.max(0.001, e.posError);
      dummy.position.set(e.pos.x, 0.03, e.pos.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(r, 1, r);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      errorRingMesh.setMatrixAt(k, dummy.matrix);
      errorRingMesh.setColorAt(k, col.setHex(ghost ? GHOST_COLOR : SIDE_COLOR[view.enemySide]));

      k++;
    }
    contactMesh.count = k;
    errorRingMesh.count = opts.debug.showContactRings ? k : 0;
    contactMesh.instanceMatrix.needsUpdate = true;
    errorRingMesh.instanceMatrix.needsUpdate = true;
    if (contactMesh.instanceColor) contactMesh.instanceColor.needsUpdate = true;
    if (errorRingMesh.instanceColor) errorRingMesh.instanceColor.needsUpdate = true;

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
          blasts.push({ x: f.at.x, z: f.at.z, radius: f.radius, side: f.side, life: BLAST_LIFE });
        }
      }
      lastFxTick = world.tick;
    }
    for (const t of tracers) t.life -= dt;
    for (const b of blasts) b.life -= dt;
    tracers = tracers.filter((t) => t.life > 0);
    blasts = blasts.filter((b) => b.life > 0);

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

    for (let j = 0; j < MAX_BLASTS; j++) {
      const slot = blastPool[j]!;
      const b = j < blasts.length ? blasts[j]! : null;
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

  // ── カメラ操作: ドラッグでパン、ホイールでズーム ──
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
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
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
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
      discGeo.dispose();
      wedgeGeo.dispose();
      rankGeo.dispose();
      (rankMesh.material as THREE.Material).dispose();
      discMesh.dispose();
      wedgeMesh.dispose();
      controlRing.geometry.dispose();
      selectRing.geometry.dispose();
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
