/**
 * UIモックアップ生成(`[v6.5]`)。
 *
 * **デザイナーに渡すための1枚もののHTML**を書き出す。中隊 vs 中隊の代表的な2画面
 * ——「作戦立案(開始前)」と「戦闘中(約3分)」—— を、実際のシミュレーションから
 * 取った本物の状態で再現する。手描きのモックではないので、部隊の密度・建物の数・
 * 情報量が実物と一致している(そこがずれたモックは、たいてい実装で破綻する)。
 *
 * 出力は自己完結: 外部アセットもJSもフォントも要らない。地図はインラインSVG、HUDは
 * 実際のアプリと**同じクラス名**のHTMLで、色はすべてファイル冒頭の CSS カスタム
 * プロパティに寄せてある。デザイナーはそこを触るだけで全体の配色を差し替えられる。
 *
 * 実行: `npm run mockup` → `docs/design/ui-mockup-company.html`
 *
 * 反映の手順(デザイナー → 実装):
 *   - 色を変えた → `src/ui/styles.css` の `:root` と `src/render/renderer.ts` の
 *     色定数の**両方**を揃えて直す(地図側はCSSを読まないので二重管理になっている)
 *   - レイアウトを変えた → `src/ui/styles.css` の該当クラス
 *   - 記号の形・大きさを変えた → `src/render/renderer.ts` のジオメトリ
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createWorld, type World } from "../sim/world.ts";
import { runTicks } from "../sim/step.ts";
import { companyClashScenario } from "../sim/scenario.ts";
import { beginBattle, beginPlanning, platoonName } from "../sim/c2/planning.ts";
import { resolveView, type ViewResult } from "../sim/viewpoint.ts";
import { isOffField } from "../sim/systems/litter.ts";
import { LITTER, SIM_DT, SOLDIER_RADIUS } from "../sim/constants.ts";
import { insideBounds } from "../sim/cqb.ts";
import type { AABB, Side, Soldier, Vec2 } from "../sim/types.ts";

const OUT = "docs/design/ui-mockup-company.html";
/** 戦闘画面を切り出す時刻(秒)。遭遇戦が始まり、負傷者と担架班が出ている頃 */
const BATTLE_SEC = 180;

// ─────────────────────────────────────────────────────────────────────────────
// 色 — src/render/renderer.ts と src/ui/styles.css の値をここに集約する。
// 生成物の CSS カスタムプロパティとして出るので、デザイナーはここ相当の1箇所を触る。
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  ground: "#9c8763",
  outOfPlay: "#453c2e",
  wall: "#d9c9a4",
  clutter: "#6a5230",
  roomFloor: "#6d5f47",
  shadow: "#2b2318",
  doorClosed: "#7c4a1e",
  doorOpen: "#413524",
  blue: "#2f74d8",
  red: "#d8342f",
  wia: "#ffcc17",
  stabilized: "#2fbf72",
  carrying: "#7ad3ff",
  kia: "#3a352b",
  suppressed: "#f3e8cf",
  objNeutral: "#22c07f",
  objContested: "#f0a81c",
  ghost: "#6a6252",
  control: "#ffffff",
  order: "#ffc21e",
  select: "#00e0ff",
  tracerHit: "#fff0a0",
  tracerMiss: "#5c5341",
  panel: "rgba(26, 21, 14, 0.86)",
  border: "#4c4133",
  text: "#ece2cf",
  muted: "#a3947a",
  btn: "#2b2419",
  btnHover: "#3d3324",
  btnAlt: "#241e14",
  hudBlue: "#4a8ce6",
  hudRed: "#e8483c",
};

/** 影のずれ m(renderer.ts の SHADOW_DX / SHADOW_DZ と同値)。 */
const SHADOW_DX = 2.4;
const SHADOW_DZ = 3.2;

const n = (v: number): string => (Math.round(v * 10) / 10).toString();
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 建物idから色味を振る(renderer.ts の buildingTint と同じ意図の簡易版)。 */
function tint(hex: string, id: number, spread: number): string {
  const h = ((id * 2654435761) >>> 0) / 4294967296;
  const k = 1 + (h - 0.5) * spread;
  const num = parseInt(hex.slice(1), 16);
  const ch = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(c * k))),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** その壁がどの建物のものか(renderer.ts と同じ判定)。 */
function buildingIdOfWall(world: World, w: AABB): number | null {
  return (
    world.buildings.find(
      (b) =>
        w.cx >= b.bounds.minX - 0.8 &&
        w.cx <= b.bounds.maxX + 0.8 &&
        w.cz >= b.bounds.minZ - 0.8 &&
        w.cz <= b.bounds.maxZ + 0.8,
    )?.id ?? null
  );
}

/** 兵士トークンの色(renderer.ts の分岐と同じ順序)。 */
function soldierColor(s: Soldier, tick: number): string {
  if (s.status === "kia") return C.kia;
  if (s.status === "wia") {
    if (s.evac === "carrying") return C.carrying;
    return s.stabilized ? C.stabilized : C.wia;
  }
  if (s.bearing !== null) return C.carrying;
  if (s.suppressedUntilTick > tick) return C.suppressed;
  return s.side === "blue" ? C.blue : C.red;
}

/** 階級(指揮継承の結果から引く。renderer.ts と同じ)。 */
function rankOf(world: World): Map<number, "co" | "pl" | "sq" | "ft"> {
  const m = new Map<number, "co" | "pl" | "sq" | "ft">();
  for (const s of world.soldiers) if (s.isFireteamLeader) m.set(s.id, "ft");
  for (const sq of world.squads) if (sq.commanderId !== null) m.set(sq.commanderId, "sq");
  for (const pl of world.platoons) if (pl.commanderId !== null) m.set(pl.commanderId, "pl");
  for (const co of world.companies) if (co.commanderId !== null) m.set(co.commanderId, "co");
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// 地図(インラインSVG)
// ─────────────────────────────────────────────────────────────────────────────

interface MapOpts {
  /** 立案フェーズの接近経路(陣営色の折れ線 + 矢羽根) */
  routes?: Array<{ side: Side; main: boolean; points: Vec2[] }>;
  /** 敵を実体で描くか(立案フェーズは盤面の設定なので両軍を見せる) */
  showEnemyTruth: boolean;
}

function mapSvg(world: World, view: ViewResult, opts: MapOpts): string {
  const b = world.bounds;
  const W = b.maxX - b.minX;
  const H = b.maxZ - b.minZ;
  const out: string[] = [];
  const g = (cls: string, body: string): void => {
    out.push(`<g class="${cls}">${body}</g>`);
  };

  // 地面
  g(
    "m-ground",
    `<rect x="${n(b.minX)}" y="${n(b.minZ)}" width="${n(W)}" height="${n(H)}" fill="var(--map-ground)"/>` +
      `<rect x="${n(b.minX)}" y="${n(b.minZ)}" width="${n(W)}" height="${n(H)}" fill="url(#sand)"/>` +
      `<rect x="${n(b.minX)}" y="${n(b.minZ)}" width="${n(W)}" height="${n(H)}" fill="none" stroke="#6b5d45" stroke-width="0.6"/>`,
  );

  // 建物の影
  g(
    "m-shadow",
    world.buildings
      .map(
        (bd) =>
          `<rect x="${n(bd.bounds.minX + SHADOW_DX)}" y="${n(bd.bounds.minZ + SHADOW_DZ)}" ` +
          `width="${n(bd.bounds.maxX - bd.bounds.minX)}" height="${n(bd.bounds.maxZ - bd.bounds.minZ)}"/>`,
      )
      .join(""),
  );

  // 部屋の床
  g(
    "m-floor",
    world.buildings
      .flatMap((bd) =>
        bd.rooms.map(
          (r) =>
            `<rect x="${n(r.bounds.minX)}" y="${n(r.bounds.minZ)}" ` +
            `width="${n(r.bounds.maxX - r.bounds.minX)}" height="${n(r.bounds.maxZ - r.bounds.minZ)}" ` +
            `fill="${tint(C.roomFloor, bd.id, 0.16)}"/>`,
        ),
      )
      .join(""),
  );

  // 壁(建物 / 街路の遮蔽)
  const walls: string[] = [];
  for (const w of world.structuralWalls) {
    const bid = buildingIdOfWall(world, w);
    const fill = bid !== null ? tint(C.wall, bid, 0.14) : "var(--map-clutter)";
    walls.push(
      `<rect x="${n(w.cx - w.hw)}" y="${n(w.cz - w.hd)}" width="${n(w.hw * 2)}" height="${n(w.hd * 2)}" fill="${fill}"/>`,
    );
  }
  g("m-wall", walls.join(""));

  // 扉
  g(
    "m-door",
    world.doors
      .map((d) => {
        const alongX = Math.abs(d.normal.x) > Math.abs(d.normal.z);
        const w = alongX ? 0.35 : d.width;
        const h = alongX ? d.width : 0.35;
        const fill = d.open ? "var(--map-door-open)" : "var(--map-door-closed)";
        return `<rect x="${n(d.pos.x - w / 2)}" y="${n(d.pos.z - h / 2)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
      })
      .join(""),
  );

  // 負傷者集合点(CCP)
  g(
    "m-ccp",
    (["blue", "red"] as Side[])
      .map((side) => {
        const p = world.ccp[side];
        const c = side === "blue" ? "var(--map-blue)" : "var(--map-red)";
        return (
          `<circle cx="${n(p.x)}" cy="${n(p.z)}" r="${n(LITTER.EVAC_RADIUS)}" fill="none" stroke="${c}" stroke-width="0.45" opacity="0.6"/>` +
          `<path d="M ${n(p.x - 0.8)} ${n(p.z)} h 1.6 M ${n(p.x)} ${n(p.z - 0.8)} v 1.6" stroke="#fff" stroke-width="0.5" opacity="0.85"/>`
        );
      })
      .join(""),
  );

  // 拠点(リング + 確保の塗り + 画面上で一定サイズの標)。
  // **接近経路より後に描く** — 矢羽根が目標に重なるので、標が下敷きになると
  // どこが拠点か読めなくなる(実装側は renderOrder で同じ順序にしてある)
  const objPin = 6; // 盤面全体を見ているときの標の半径 m(実装は viewSpan に比例)
  const objLayer = (): void =>
    g(
      "m-obj",
    world.objectives
      .map((o) => {
        const owner = o.owner ?? o.progressBy;
        const c = o.contested
          ? "var(--map-obj-contested)"
          : owner
            ? owner === "blue"
              ? "var(--map-blue)"
              : "var(--map-red)"
            : "var(--map-obj-neutral)";
        const fillR = Math.max(0.001, o.progress * o.radius);
        return (
          `<circle cx="${n(o.pos.x)}" cy="${n(o.pos.z)}" r="${n(o.radius)}" fill="none" stroke="${c}" stroke-width="0.5" opacity="0.85"/>` +
          `<circle cx="${n(o.pos.x)}" cy="${n(o.pos.z)}" r="${n(fillR)}" fill="${c}" opacity="0.26"/>` +
          `<rect x="${n(o.pos.x - objPin / 2)}" y="${n(o.pos.z - objPin / 2)}" width="${objPin}" height="${objPin}" ` +
          `transform="rotate(45 ${n(o.pos.x)} ${n(o.pos.z)})" fill="${c}"/>`
        );
      })
      .join(""),
    );

  // 立案フェーズの接近経路
  if (opts.routes?.length) {
    const parts: string[] = [];
    for (const r of opts.routes) {
      const c = r.side === "blue" ? "var(--map-blue)" : "var(--map-red)";
      const d = r.points.map((p, i) => `${i === 0 ? "M" : "L"} ${n(p.x)} ${n(p.z)}`).join(" ");
      parts.push(
        `<path d="${d}" fill="none" stroke="${c}" stroke-width="${r.main ? 0.9 : 0.6}" opacity="${r.main ? 0.95 : 0.7}"/>`,
      );
      // 進行方向の山形を等間隔で撒く(実装と同じ 14m 間隔)
      for (let i = 0; i + 1 < r.points.length; i++) {
        const p0 = r.points[i]!;
        const p1 = r.points[i + 1]!;
        const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        const deg = (Math.atan2(p1.x - p0.x, p1.z - p0.z) * 180) / Math.PI;
        for (let t = 14; t < len - 4; t += 14) {
          const x = p0.x + ((p1.x - p0.x) * t) / len;
          const z = p0.z + ((p1.z - p0.z) * t) / len;
          const s = r.main ? 1.7 : 1.35;
          parts.push(
            `<path d="M ${n(x)} ${n(z + s)} L ${n(x - s * 0.9)} ${n(z - s * 0.7)} L ${n(x + s * 0.9)} ${n(z - s * 0.7)} Z" ` +
              `transform="rotate(${n(deg)} ${n(x)} ${n(z)})" fill="${c}" opacity="0.85"/>`,
          );
        }
      }
      const a = r.points[r.points.length - 2]!;
      const e = r.points[r.points.length - 1]!;
      const deg = (Math.atan2(e.x - a.x, e.z - a.z) * 180) / Math.PI;
      const s = r.main ? 4.5 : 3.2;
      parts.push(
        `<path d="M ${n(e.x)} ${n(e.z + s)} L ${n(e.x - s * 0.9)} ${n(e.z - s * 0.7)} L ${n(e.x + s * 0.9)} ${n(e.z - s * 0.7)} Z" ` +
          `transform="rotate(${n(deg)} ${n(e.x)} ${n(e.z)})" fill="${c}" opacity="0.95"/>`,
      );
    }
    g("m-route", parts.join(""));
  }
  objLayer();

  // 敵接触(報告された最終目撃位置 + 不確度円)。仕様 §5
  if (view.enemies.length) {
    g(
      "m-contact",
      view.enemies
        .map((e) => {
          const c = e.confidence <= 0 ? "var(--map-ghost)" : "var(--map-red)";
          const r = SOLDIER_RADIUS * 2;
          return (
            `<circle cx="${n(e.pos.x)}" cy="${n(e.pos.z)}" r="${n(Math.max(0.4, e.posError))}" ` +
            `fill="none" stroke="${c}" stroke-width="0.25" opacity="0.28"/>` +
            `<rect x="${n(e.pos.x - r / 2)}" y="${n(e.pos.z - r / 2)}" width="${n(r)}" height="${n(r)}" ` +
            `transform="rotate(45 ${n(e.pos.x)} ${n(e.pos.z)})" fill="${c}" opacity="${e.confidence <= 0 ? 0.6 : 0.95}"/>`
          );
        })
        .join(""),
    );
  }

  // 発砲線(そのティックに起きた射撃)
  // 実際には0.11秒で消える表現なので、静止画では実物より賑やかに見える
  const tracers = world.fx.filter((f) => f.kind === "shot");
  if (tracers.length) {
    g(
      "m-tracer",
      tracers
        .map((f) =>
          f.kind === "shot"
            ? `<line x1="${n(f.from.x)}" y1="${n(f.from.z)}" x2="${n(f.to.x)}" y2="${n(f.to.z)}" ` +
              `stroke="${f.hit ? "var(--map-tracer-hit)" : "var(--map-tracer-miss)"}" stroke-width="0.3" opacity="0.9"/>`
            : "",
        )
        .join(""),
    );
  }

  // 兵士(影 → 円盤 → 向きのくさび → 階級章)
  const ranks = rankOf(world);
  const tokens: Soldier[] = opts.showEnemyTruth
    ? view.friendly.concat(view.enemiesTruth)
    : view.friendly;
  const shadows: string[] = [];
  const discs: string[] = [];
  const wedges: string[] = [];
  const marks: string[] = [];
  for (const s of tokens) {
    if (isOffField(s)) continue;
    const dead = s.status === "kia";
    const r = SOLDIER_RADIUS * 1.6 * (dead ? 0.7 : 1);
    shadows.push(
      `<circle cx="${n(s.pos.x + SHADOW_DX * 0.09)}" cy="${n(s.pos.z + SHADOW_DZ * 0.09)}" r="${n(r * 1.06)}"/>`,
    );
    discs.push(
      `<circle cx="${n(s.pos.x)}" cy="${n(s.pos.z)}" r="${n(r)}" fill="${soldierColor(s, world.tick)}"/>`,
    );
    if (!dead) {
      const deg = (Math.atan2(s.facing.x, s.facing.z) * 180) / Math.PI;
      const w = SOLDIER_RADIUS * 1.5;
      const cx = s.pos.x + s.facing.x * SOLDIER_RADIUS * 0.9;
      const cz = s.pos.z + s.facing.z * SOLDIER_RADIUS * 0.9;
      const base = s.side === "blue" ? C.blue : C.red;
      wedges.push(
        `<path d="M ${n(cx)} ${n(cz + w)} L ${n(cx - w * 0.87)} ${n(cz - w * 0.5)} L ${n(cx + w * 0.87)} ${n(cz - w * 0.5)} Z" ` +
          `transform="rotate(${n(deg)} ${n(cx)} ${n(cz)})" fill="${tint(base, 7, 0.5)}"/>`,
      );
      const rank = ranks.get(s.id);
      if (rank) {
        const c = tint(base, 3, 0.6);
        const y = s.pos.z - SOLDIER_RADIUS * 2.4;
        if (rank === "ft" || rank === "sq") {
          const pips = rank === "sq" ? 2 : 1;
          for (let q = 0; q < pips; q++) {
            const dx = (q - (pips - 1) / 2) * 0.36;
            marks.push(
              `<rect x="${n(s.pos.x + dx - 0.13)}" y="${n(y - 0.13)}" width="0.26" height="0.26" fill="${c}"/>`,
            );
          }
        } else {
          const bars = rank === "co" ? 2 : 1;
          for (let q = 0; q < bars; q++) {
            marks.push(
              `<rect x="${n(s.pos.x - 0.48)}" y="${n(y - q * 0.3 - 0.085)}" width="0.95" height="0.17" fill="${c}"/>`,
            );
          }
        }
      }
    }
  }
  g("m-soldier-shadow", shadows.join(""));
  g("m-soldier", discs.join(""));
  g("m-wedge", wedges.join(""));
  g("m-rank", marks.join(""));

  return (
    `<svg class="map" viewBox="${n(b.minX)} ${n(b.minZ)} ${n(W)} ${n(H)}" preserveAspectRatio="xMidYMid meet">` +
    `<defs>` +
    // 砂地のむら。実装は canvas の手続き生成だが、SVGでは pattern にしてある
    `<pattern id="sand" width="16" height="16" patternUnits="userSpaceOnUse">` +
    `<circle cx="4" cy="5" r="3.2" fill="#c6b28c" opacity="0.07"/>` +
    `<circle cx="12" cy="11" r="4" fill="#66563a" opacity="0.07"/>` +
    `<circle cx="13" cy="3" r="2" fill="#c6b28c" opacity="0.05"/>` +
    `<circle cx="3" cy="13" r="2.4" fill="#66563a" opacity="0.05"/>` +
    `</pattern>` +
    `</defs>` +
    out.join("") +
    `</svg>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD(実アプリと同じクラス名のHTML)
// ─────────────────────────────────────────────────────────────────────────────

function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${Math.floor(sec % 60)
    .toString()
    .padStart(2, "0")}`;
}

function forceCounts(world: World): string {
  const row = (side: Side, label: string): string => {
    const men = world.soldiers.filter((s) => s.side === side);
    const eff = men.filter((s) => s.status === "ok").length;
    const alive = men.filter((s) => s.status !== "kia").length;
    const wait = men.filter((s) => s.status === "wia" && !isOffField(s)).length;
    const evac = men.filter((s) => isOffField(s)).length;
    return `<div class="force force-${side}"><span class="force-label">${label}</span>
      <span class="mono">${eff}/${alive}</span>
      <span class="force-evac mono">▲${wait} ✚${evac}</span></div>`;
  };
  return `<div class="hud-forces">${row("blue", "BLUE")}${row("red", "RED")}</div>`;
}

function echelonTree(world: World): string {
  const rows: string[] = [`<div class="et-title">指揮階層(クリックで交代)</div>`];
  rows.push(`<button class="et-node et-on"><span class="et-name">観戦(全AI)</span></button>`);
  for (const co of world.companies.filter((c) => c.side === "blue")) {
    const men = world.soldiers.filter((s) => s.side === co.side && s.companyId === co.companyId);
    rows.push(
      `<div class="et-group"><button class="et-node"><span class="et-rank">中隊長</span>` +
        `<span class="et-name">${co.companyId}中隊</span>` +
        `<span class="et-strength">${men.filter((s) => s.status === "ok").length}/${men.length}</span></button>`,
    );
    for (const pl of world.platoons.filter(
      (p) => p.side === co.side && p.companyId === co.companyId,
    )) {
      const pm = world.soldiers.filter((s) => s.side === pl.side && s.platoonId === pl.platoonId);
      rows.push(
        `<button class="et-node et-child"><span class="et-rank">小隊長</span>` +
          `<span class="et-name">${platoonName(pl.platoonId)}</span>` +
          `<span class="et-strength">${pm.filter((s) => s.status === "ok").length}/${pm.length}</span></button>`,
      );
      for (const sq of world.squads.filter(
        (q) => q.side === pl.side && q.platoonId === pl.platoonId,
      )) {
        const sm = world.soldiers.filter((s) => s.side === sq.side && s.squadId === sq.squadId);
        rows.push(
          `<button class="et-node et-grandchild"><span class="et-rank">分隊長</span>` +
            `<span class="et-name">${sq.squadId}分隊</span>` +
            `<span class="et-strength">${sm.filter((s) => s.status === "ok").length}/${sm.length}</span></button>`,
        );
      }
    }
    rows.push(`</div>`);
  }
  return `<div class="echelon-tree">${rows.join("")}</div>`;
}

function objectivePanel(world: World): string {
  return (
    `<div class="objectives">` +
    world.objectives
      .map(
        (o) =>
          `<div class="obj-row"><span class="obj-dot obj-${o.owner ?? "neutral"}"></span>` +
          `<span class="obj-label">${esc(o.label)}</span>` +
          `<span class="obj-bar"><span class="obj-fill obj-${o.contested ? "contested" : (o.owner ?? "neutral")}" style="width:${Math.round(o.progress * 100)}%"></span></span>` +
          (o.contested ? `<span class="obj-contested">係争中</span>` : "") +
          `</div>`,
      )
      .join("") +
    `</div>`
  );
}

const FT_MODE_JP: Record<string, string> = {
  ADVANCE: "前進",
  CONTACT: "交戦",
  SEARCH: "掃討",
  FALLBACK: "後退",
  CQB: "室内戦",
  ROUT: "潰走",
};
const TECH_JP: Record<string, string> = {
  traveling: "前進",
  traveling_overwatch: "警戒前進",
  bounding_overwatch: "躍進前進",
};

function thinkingPanel(world: World): string {
  const rows: string[] = [`<div class="tp-title">分隊 / FT の思考（BLUE）</div>`];
  const squads = world.squads.filter((s) => s.side === "blue").slice(0, 8);
  for (const sq of squads) {
    const fts = world.fireteams.filter((f) => f.side === "blue" && f.squadId === sq.squadId);
    rows.push(
      `<div class="tp-squad"><div class="tp-squad-head"><span class="tp-name">${sq.squadId}分隊</span>` +
        `<span class="tp-tech">${TECH_JP[sq.technique] ?? sq.technique}</span>` +
        (sq.assaultDoorId !== null ? `<span class="tp-tag tp-cqb">室内戦</span>` : "") +
        (sq.degradedSinceTick !== null ? `<span class="tp-tag tp-deg">継承中</span>` : "") +
        `</div>` +
        fts
          .map(
            (f) =>
              `<div class="tp-ft"><span class="tp-ft-name">FT${f.ftIndex}</span>` +
              `<span class="tp-mode">${FT_MODE_JP[f.mode] ?? f.mode}</span>` +
              `<span class="tp-role">[${f.assignedRole === "base" ? "制圧" : f.assignedRole === "maneuver" ? "機動" : "—"}]</span></div>`,
          )
          .join("") +
        `</div>`,
    );
  }
  return `<div class="thinking-panel">${rows.join("")}</div>`;
}

function planPanel(world: World): string {
  const co = world.companies.find((c) => c.side === "blue");
  const plan = co?.plan;
  if (!plan) return "";
  const roleJp: Record<string, string> = { main: "主攻", supporting: "助攻", reserve: "予備" };
  const missionJp: Record<string, string> = {
    seize: "確保",
    support_by_fire: "支援射撃",
    screen: "掩護",
  };
  const tasks = [...plan.tasks].sort(
    (a, b) =>
      (a.role === "main" ? 0 : a.role === "supporting" ? 1 : 2) -
        (b.role === "main" ? 0 : b.role === "supporting" ? 1 : 2) || a.platoonId - b.platoonId,
  );
  return (
    `<div class="plan-panel">` +
    `<div class="plan-head"><span class="plan-title">作戦立案</span>` +
    `<span class="plan-sub">中隊長が拠点に対する計画を立てました。開始するまで時間は止まっています。</span></div>` +
    `<div class="plan-body"><div class="plan-force">` +
    `<div class="plan-force-head force-blue"><span class="force-label">BLUE</span>` +
    `<span class="plan-intent">${esc(plan.intent)}</span></div>` +
    tasks
      .map(
        (t) =>
          `<div class="plan-task"><span class="plan-role plan-role-${t.role}">${roleJp[t.role]}</span>` +
          `<span class="plan-mission">${missionJp[t.mission.kind]}</span>` +
          `<span class="plan-order">${esc(t.order)}</span></div>`,
      )
      .join("") +
    `</div></div>` +
    `<div class="plan-foot"><button class="plan-start">▶ 戦闘開始 <span class="plan-key">Enter</span></button>` +
    `<button class="vc-btn">配置を変える (G)</button>` +
    `<span class="dbg-k">配置を変えると中隊長が立案し直します</span></div>` +
    `</div>`
  );
}

const VIEW_CONTROLS = `<div class="view-controls">
  <div class="vc-row"><span class="vc-label">規模</span>
    <button class="vc-btn">分隊<br>vs 分隊</button><button class="vc-btn">小隊<br>vs 小隊</button>
    <button class="vc-btn vc-on">中隊<br>vs 中隊</button><button class="vc-btn">市街地<br>(CQB)</button></div>
  <div class="vc-row"><span class="vc-label">視点</span>
    <button class="vc-btn">中隊長</button><button class="vc-btn vc-on">小隊長</button>
    <button class="vc-btn">分隊長</button><button class="vc-btn">神視点</button></div>
  <div class="vc-row"><span class="vc-label">陣営</span>
    <button class="vc-btn vc-on vc-blue">BLUE</button><button class="vc-btn">RED</button></div>
  <div class="vc-row"><span class="vc-label">配置</span>
    <button class="vc-btn">初期配置・拠点を編集</button></div>
</div>`;

const LEGEND = `<div class="legend">
  <div class="lg-head"><span>凡例</span><button class="dbg-x">×</button></div>
  <div class="lg-row"><span class="lg-cap">兵士</span>
    <span class="lg-item"><span class="lg-dot" style="background:var(--map-blue)"></span>BLUE</span>
    <span class="lg-item"><span class="lg-dot" style="background:var(--map-red)"></span>RED</span>
    <span class="lg-item"><span class="lg-dot" style="background:var(--map-suppressed)"></span>制圧中</span>
    <span class="lg-item"><span class="lg-dot" style="background:var(--map-wia)"></span>出血中</span>
    <span class="lg-item"><span class="lg-dot" style="background:var(--map-stabilized)"></span>止血済</span>
    <span class="lg-item"><span class="lg-dot" style="background:var(--map-carrying)"></span>担架</span>
    <span class="lg-item"><span class="lg-dot" style="background:var(--map-kia)"></span>戦死</span></div>
  <div class="lg-row"><span class="lg-cap">標識</span>
    <span class="lg-item"><span class="lg-dot lg-diamond" style="background:var(--map-red)"></span>敵(報告)</span>
    <span class="lg-item"><span class="lg-dot lg-diamond" style="background:var(--map-ghost)"></span>ゴースト</span>
    <span class="lg-item"><span class="lg-dot lg-ring" style="border-color:var(--map-obj-neutral)"></span>拠点・中立</span>
    <span class="lg-item"><span class="lg-dot lg-ring" style="border-color:var(--map-obj-contested)"></span>拠点・係争中</span>
    <span class="lg-item"><span class="lg-dot lg-ring" style="border-color:var(--map-control)"></span>操作中</span>
    <span class="lg-item"><span class="lg-dot lg-ring" style="border-color:var(--map-select)"></span>選択・麾下</span>
    <span class="lg-item"><span class="lg-dot lg-bar" style="background:var(--map-door-closed)"></span>閉じた扉</span></div>
  <div class="lg-row"><span class="lg-cap">階級</span>
    <span class="lg-item"><span class="lg-rankmark">▪</span>FTリーダー</span>
    <span class="lg-item"><span class="lg-rankmark">▪▪</span>分隊長</span>
    <span class="lg-item"><span class="lg-rankmark">▬</span>小隊長</span>
    <span class="lg-item"><span class="lg-rankmark">▬▬</span>中隊長</span></div>
</div>`;

const HINT = `<div class="hud-hint">ドラッグ: 移動 · ホイール: 拡大縮小 · Space: 一時停止 · . : 1ティック · 左クリック: ユニット選択 · H: デバッグ · G: 配置 · L: 凡例</div>`;

function screen(
  title: string,
  note: string,
  world: World,
  view: ViewResult,
  opts: MapOpts,
  planning: boolean,
): string {
  const time = planning
    ? `<div class="time-controls"><span class="tc-planning">作戦立案中 — 時間は止まっています</span></div>`
    : `<div class="time-controls"><button class="tc-btn">❚❚ 一時停止</button><button class="tc-btn">×1</button><button class="tc-btn" disabled>⏭ ステップ</button></div>`;
  return `<section class="shot">
  <h2>${esc(title)}</h2>
  <p class="shot-note">${esc(note)}</p>
  <div class="screen-slot"><div class="screen">
    ${mapSvg(world, view, opts)}
    <div class="hud">
      <div class="hud-top">
        <div class="hud-clock"><span class="mono">${clock(world.tick * SIM_DT)}</span><span class="hud-tick mono">tick ${world.tick}</span></div>
        ${time}
      </div>
      <div class="control-banner cb-idle"><span class="cb-side">観戦</span><span class="cb-unit">全ユニットAI制御</span><span class="cb-view">視点: 小隊長</span></div>
      ${forceCounts(world)}
      ${VIEW_CONTROLS}
      ${planning ? planPanel(world) : thinkingPanel(world)}
      ${objectivePanel(world)}
      ${echelonTree(world)}
      ${LEGEND}
      ${HINT}
    </div>
  </div></div>
</section>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 生成
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  // ① 作戦立案フェーズ
  const wPlan = createWorld(companyClashScenario(1));
  beginPlanning(wPlan);
  const planView = resolveView(wPlan, { side: "blue", echelon: "truth" });
  // 経路は**自陣営のみ**。敵の作戦は敵の中隊長の頭の中にあるもので、実装でも見せない
  const routes = wPlan.companies
    .filter((co) => co.side === "blue")
    .flatMap((co) =>
      (co.plan?.tasks ?? []).map((t) => ({
        side: co.side,
        main: t.role === "main",
        points: t.route,
      })),
    );

  // ② 戦闘中(約3分)
  const wBattle = createWorld(companyClashScenario(1));
  beginPlanning(wBattle);
  beginBattle(wBattle);
  runTicks(wBattle, Math.round(BATTLE_SEC / SIM_DT));
  const battleView = resolveView(wBattle, { side: "blue", echelon: "platoon", platoonId: 1 });

  const indoor = wBattle.soldiers.filter(
    (s) => s.status === "ok" && wBattle.buildings.some((b) => insideBounds(b.bounds, s.pos)),
  ).length;

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>ECHELON — 中隊 vs 中隊 プレイ画面スナップショット</title>
<style>
/*
 * ─────────────────────────────────────────────────────────────────────────
 * ECHELON UI モックアップ — デザイナー向け
 *
 * これは手描きのモックではなく、**実際のシミュレーションから取った本物の状態**を
 * そのまま描いたものです(建物34棟 × 2、両軍224名、拠点3個)。情報量と密度が
 * 実物と一致しているので、ここで成立する配色・レイアウトはそのまま実装に載ります。
 *
 * 触るところ: 下の :root。色はすべてここに集約してあります。
 *   --map-*   … 地図(SVG)側の色。実装では src/render/renderer.ts の定数
 *   その他     … HUD側の色。実装では src/ui/styles.css の :root
 * クラス名は実装と同じなので、レイアウトの変更もそのまま移せます。
 *
 * 注意: 地図はWebGLで描いており、CSSを読みません。色を変えたら
 * renderer.ts と styles.css の**両方**を揃える必要があります(現状の二重管理)。
 * ─────────────────────────────────────────────────────────────────────────
 */
:root {
  color-scheme: dark;
  font-family: system-ui, "Segoe UI", "Yu Gothic UI", sans-serif;

  /* ── 地図(SVG) ── */
  --map-ground: ${C.ground};          /* 屋外の地面。乾いた土 */
  --map-out-of-play: ${C.outOfPlay};  /* 盤外 */
  --map-clutter: ${C.clutter};        /* 街路の低い遮蔽(塀・土嚢・車列) */
  --map-shadow: ${C.shadow};          /* 建物・兵士が落とす影 */
  --map-door-closed: ${C.doorClosed}; /* 閉じた扉。視線も移動も遮る */
  --map-door-open: ${C.doorOpen};     /* 開いた扉 */
  --map-blue: ${C.blue};              /* BLUE の兵士・標識 */
  --map-red: ${C.red};                /* RED の兵士・標識 */
  --map-suppressed: ${C.suppressed};  /* 制圧されている兵士 */
  --map-wia: ${C.wia};                /* 出血中 */
  --map-stabilized: ${C.stabilized};  /* 止血済み(後送待ち) */
  --map-carrying: ${C.carrying};      /* 担架搬送中 */
  --map-kia: ${C.kia};                /* 戦死 */
  --map-obj-neutral: ${C.objNeutral};     /* 中立の拠点 */
  --map-obj-contested: ${C.objContested}; /* 係争中の拠点 */
  --map-ghost: ${C.ghost};            /* 確度が尽きた最終目撃情報 */
  --map-control: ${C.control};        /* 操作中ユニットのリング */
  --map-order: ${C.order};            /* 移動命令 */
  --map-select: ${C.select};          /* 選択・麾下 */
  --map-tracer-hit: ${C.tracerHit};   /* 発砲線(命中) */
  --map-tracer-miss: ${C.tracerMiss}; /* 発砲線(外れ) */

  /* ── HUD ── */
  --blue: ${C.hudBlue};
  --red: ${C.hudRed};
  --panel: ${C.panel};
  --border: ${C.border};
  --text: ${C.text};
  --muted: ${C.muted};
  --btn: ${C.btn};
  --btn-hover: ${C.btnHover};
  --btn-alt: ${C.btnAlt};
  --btn-alt2: #1d180f;
  --accent: ${C.order};
  --cyan: ${C.select};
  --green: ${C.objNeutral};
}

* { box-sizing: border-box; }
body { margin: 0; background: #100d08; color: var(--text); padding: 24px; }
h1 { font-size: 18px; letter-spacing: 0.1em; margin: 0 0 4px; }
h2 { font-size: 14px; letter-spacing: 0.08em; color: var(--accent); margin: 32px 0 4px; }
.lead, .shot-note { color: var(--muted); font-size: 12px; line-height: 1.7; max-width: 1100px; margin: 0 0 10px; }
.mono { font-variant-numeric: tabular-nums; font-family: "SFMono-Regular", ui-monospace, "Cascadia Mono", Consolas, monospace; }

/* 1920×1080 の画面をそのまま埋め込む。幅に合わせて等倍縮小する */
.shot { max-width: 1920px; }
.screen {
  position: relative;
  width: 1920px; height: 1080px;
  transform-origin: top left;
  background: var(--map-out-of-play);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
/* 画面幅に合わせた等倍縮小は末尾の小さなスクリプトが行う(CSSのcalcでは
   length / length が書けないため)。--k を書き換えれば手動でも調整できる */
.shot { --k: 1; }
.screen { transform: scale(var(--k)); }
.screen-slot { height: calc(1080px * var(--k)); overflow: hidden; }
.map { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.m-shadow rect { fill: var(--map-shadow); opacity: 0.3; }
.m-soldier-shadow circle { fill: var(--map-shadow); opacity: 0.42; }

/* ── 以下、実アプリの src/ui/styles.css から抜粋(クラス名は実装と同一) ── */
.hud { position: absolute; inset: 0; padding: 12px; }
.hud-top { display: flex; align-items: center; gap: 16px; }
.hud-clock { display: flex; align-items: baseline; gap: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; backdrop-filter: blur(6px); }
.hud-clock .mono:first-child { font-size: 20px; font-weight: 600; }
.hud-tick { color: var(--muted); font-size: 12px; }
.time-controls { display: flex; gap: 6px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 6px; backdrop-filter: blur(6px); }
.tc-btn { background: var(--btn); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.tc-btn:disabled { opacity: 0.4; }
.tc-planning { color: var(--accent); font-size: 12px; padding: 6px 10px; letter-spacing: 0.04em; }
.hud-forces { position: absolute; top: 12px; right: 12px; display: flex; flex-direction: column; gap: 6px; }
.force { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 175px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; backdrop-filter: blur(6px); }
.force-label { font-weight: 700; letter-spacing: 0.12em; font-size: 12px; }
.force-blue .force-label { color: var(--blue); } .force-red .force-label { color: var(--red); }
.force-evac { font-size: 11px; opacity: 0.72; white-space: nowrap; }
.hud-hint { position: absolute; left: 12px; bottom: 12px; width: 232px; line-height: 1.6; color: var(--muted); font-size: 11px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
.view-controls { position: absolute; left: 12px; top: 76px; width: 260px; display: flex; flex-direction: column; gap: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; backdrop-filter: blur(6px); }
.vc-row { display: flex; align-items: center; gap: 6px; }
.vc-label { font-size: 12px; color: var(--muted); width: 30px; flex: none; }
.vc-btn { flex: 1; background: var(--btn); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 6px; font-size: 12px; }
.vc-on { border-color: #c2a86a; color: #f3e6c6; background: var(--btn-hover); }
.vc-on.vc-blue { border-color: var(--blue); color: var(--blue); }
.echelon-tree { position: absolute; right: 12px; top: 116px; width: 216px; max-height: calc(1080px - 170px); overflow: hidden; display: flex; flex-direction: column; gap: 3px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px; backdrop-filter: blur(6px); }
.et-title { font-size: 11px; color: var(--muted); margin-bottom: 3px; }
.et-group { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.et-node { display: flex; align-items: center; gap: 6px; width: 100%; background: var(--btn); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 5px 7px; font-size: 12px; text-align: left; }
.et-child { margin-left: 10px; background: var(--btn-alt); }
.et-grandchild { margin-left: 20px; background: var(--btn-alt2); }
.et-on { border-color: var(--accent); color: var(--accent); background: #3a2f14; }
.et-rank { font-size: 10px; color: var(--muted); flex: none; }
.et-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.et-strength { font-size: 11px; color: var(--muted); flex: none; }
.objectives { position: absolute; left: 12px; bottom: 96px; width: 232px; display: flex; flex-direction: column; gap: 4px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; backdrop-filter: blur(6px); }
.obj-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.obj-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.obj-label { flex: none; width: 76px; color: var(--muted); letter-spacing: 0.04em; }
.obj-bar { flex: 1; height: 5px; border-radius: 3px; background: var(--btn); overflow: hidden; }
.obj-fill { display: block; height: 100%; }
.obj-neutral { background: var(--green); } .obj-blue { background: var(--blue); } .obj-red { background: var(--red); }
.obj-contested { background: var(--map-obj-contested); color: var(--map-obj-contested); font-size: 10px; }
span.obj-contested { background: none; flex: none; }
.control-banner { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 6px 14px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); backdrop-filter: blur(6px); font-size: 13px; white-space: nowrap; }
.cb-idle { opacity: 0.7; }
.cb-side { font-weight: 800; letter-spacing: 0.14em; font-size: 11px; }
.cb-unit { font-weight: 600; } .cb-view { color: var(--muted); font-size: 11px; }
.thinking-panel { position: absolute; left: 12px; top: 292px; width: 240px; max-height: calc(1080px - 580px); overflow: hidden; display: flex; flex-direction: column; gap: 6px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; backdrop-filter: blur(6px); font-size: 11px; }
.tp-title { font-size: 11px; color: var(--muted); }
.tp-squad { border-left: 2px solid var(--border); padding-left: 6px; }
.tp-squad-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.tp-name { font-weight: 700; } .tp-tech { color: var(--muted); }
.tp-tag { font-size: 9px; padding: 0 4px; border-radius: 3px; }
.tp-cqb { background: #3a2f14; color: var(--map-obj-contested); }
.tp-deg { background: #4a2020; color: #ff9a8a; }
.tp-ft { display: flex; gap: 6px; padding-left: 8px; color: var(--muted); }
.tp-ft-name { width: 34px; flex: none; } .tp-mode { color: var(--text); } .tp-role { color: var(--muted); }
.plan-panel { position: absolute; left: 12px; top: 292px; width: 300px; max-height: calc(1080px - 420px); overflow: hidden; display: flex; flex-direction: column; gap: 8px; background: var(--panel); border: 1px solid var(--accent); border-radius: 10px; padding: 12px 14px; backdrop-filter: blur(8px); box-shadow: 0 6px 28px rgba(0,0,0,0.45); font-size: 12px; }
.plan-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.plan-title { font-weight: 800; letter-spacing: 0.16em; color: var(--accent); font-size: 13px; }
.plan-sub, .plan-intent, .dbg-k { color: var(--muted); font-size: 11px; }
.plan-body { display: flex; flex-direction: column; gap: 10px; }
.plan-force { display: flex; flex-direction: column; gap: 3px; }
.plan-force-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.plan-task { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; padding: 4px 6px; border-radius: 5px; border: 1px solid transparent; }
.plan-role { flex: none; width: 34px; text-align: center; font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 0; }
.plan-role-main { background: #5a3a10; color: var(--accent); }
.plan-role-supporting { background: var(--btn-hover); color: var(--text); }
.plan-role-reserve { background: var(--btn-alt); color: var(--muted); }
.plan-mission { flex: none; color: var(--muted); font-size: 11px; }
.plan-order { flex: 1 1 100%; line-height: 1.5; }
.plan-foot { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.plan-start { background: #5a3a10; color: var(--accent); border: 1px solid var(--accent); border-radius: 7px; padding: 8px 18px; font-size: 14px; font-weight: 700; }
.plan-key { font-size: 10px; font-weight: 400; opacity: 0.75; border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; margin-left: 4px; }
.legend { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); max-width: 900px; display: flex; flex-direction: column; gap: 3px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; backdrop-filter: blur(6px); font-size: 11px; }
.lg-head { display: flex; justify-content: space-between; align-items: center; font-size: 10px; letter-spacing: 0.12em; color: var(--muted); }
.lg-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lg-cap { flex: none; width: 28px; color: var(--muted); font-size: 10px; }
.lg-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.lg-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; display: inline-block; }
.lg-diamond { border-radius: 2px; transform: rotate(45deg); width: 8px; height: 8px; }
.lg-ring { background: none !important; border: 2px solid currentColor; }
.lg-bar { border-radius: 2px; width: 4px; height: 11px; }
.lg-rankmark { flex: none; color: #f0e2c2; letter-spacing: -1px; font-size: 10px; }
.dbg-x { background: var(--btn); color: var(--text); border: 1px solid var(--border); border-radius: 5px; width: 18px; height: 18px; font-size: 11px; }
button { font-family: inherit; cursor: default; }
</style>
</head>
<body>
<h1>ECHELON — 中隊 vs 中隊 プレイ画面スナップショット</h1>
<p class="lead">
  自動生成(<code>npm run mockup</code> / <code>src/tools/uiMockup.ts</code>)。手描きのモックではなく、
  <b>実際のシミュレーションから取った本物の状態</b>です — 建物 ${wBattle.buildings.length} 棟、両軍 ${wBattle.soldiers.length} 名、拠点 ${wBattle.objectives.length} 個。
  情報量と密度が実物と一致しているので、ここで成立する配色・レイアウトはそのまま実装に載ります。<br>
  色はすべて <code>&lt;style&gt;</code> 冒頭の <code>:root</code> に集約してあります。クラス名は実装と同一です。
  <b>ただし地図はWebGLで描いておりCSSを読みません</b> — 色を変える場合は
  <code>src/render/renderer.ts</code> と <code>src/ui/styles.css</code> の両方を揃える必要があります(現状の二重管理)。
</p>

${screen(
  "① 作戦立案(戦闘開始前)",
  "中隊長が拠点に対する計画を立てた直後。矢印が各小隊の接近経路で、太いものが主攻。時間は止まっており、「戦闘開始」を押すまで1ティックも進みません。この画面だけは敵の初期配置も見えます(まだ戦闘ではなく盤面の設定のため)。",
  wPlan,
  planView,
  { routes, showEnemyTruth: true },
  true,
)}

${screen(
  `② 戦闘中(${BATTLE_SEC} 秒経過)`,
  `BLUE 1小隊長の視点。敵は実体ではなく「報告された最終目撃位置」(菱形)と不確度円で出ます — 見えているものしか見えないのが本作の中心です。この時点で屋内にいる兵士 ${indoor} 名、把握している敵接触 ${battleView.known} 件(うち確度切れ ${battleView.stale} 件)。長い細線は発砲線で、実機では0.11秒で消えるため静止画では実物より賑やかに見えます。`,
  wBattle,
  battleView,
  { showEnemyTruth: false },
  false,
)}

<h2>デザイナーへの申し送り</h2>
<p class="lead">
  <b>この画面で成立させたいこと</b>(優先順):
</p>
<ol class="lead">
  <li><b>224名の中から1人を見分けられる</b> — 陣営・制圧・負傷・止血・搬送・戦死が色だけで畳み込まれています。
      引きの絵(この縮尺)で、少なくとも「健常 / 負傷 / 戦死」の3段は判別できる必要があります。</li>
  <li><b>建物・街路の遮蔽・扉が別物として読める</b> — 突入できるのは扉からだけなので、扉の視認性は操作に直結します。</li>
  <li><b>拠点が見つかる</b> — 拠点は建物の一室(半径3m)です。地図を引くと十数ピクセルになるため、
      標だけは画面上のサイズを一定に保っています。</li>
  <li><b>「見えていない」ことが読める</b> — 敵の菱形は最終目撃位置で、不確度円は時間とともに広がります。
      実体と見間違えると本作の情報設計が伝わりません。</li>
  <li><b>HUDが地図を隠さない</b> — 左右の列は 16:9 では盤面の外に来ます。下中央の凡例と、
      立案パネルの位置はここで詰めた結果です(中央下に置くと下側の陣営の初期配置が隠れました)。</li>
</ol>
<p class="lead">
  <b>まだ決めきれていないところ</b>: 階級章(点1/点2/棒1/棒2)は情報としては効いていますが記号として弱い。
  制圧中の「白茶けた色」は負傷の黄と紛れやすい。担架班と負傷者が同じ水色で、運んでいる側と運ばれている側が
  区別できない。このあたりは記号を足す/形を変えるほうが素直かもしれません。
</p>
<script>
// 1920×1080 の画面を、ウィンドウ幅に合わせて等倍縮小するだけ。
// 拡大して細部を見たいときは、この行を消すか --k を固定値にしてください。
(function fit() {
  var k = Math.min(1, (document.documentElement.clientWidth - 56) / 1920);
  for (var el of document.querySelectorAll(".shot")) el.style.setProperty("--k", k);
})();
addEventListener("resize", function () {
  var k = Math.min(1, (document.documentElement.clientWidth - 56) / 1920);
  for (var el of document.querySelectorAll(".shot")) el.style.setProperty("--k", k);
});
</script>
</body>
</html>
`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html, "utf8");
  const kb = Math.round(Buffer.byteLength(html, "utf8") / 1024);
  console.log(`${OUT} を書き出しました (${kb} KB)`);
  console.log(`  ① 立案フェーズ: 経路 ${routes.length} 本`);
  console.log(
    `  ② 戦闘 ${BATTLE_SEC}秒: 生存 BLUE ${wBattle.soldiers.filter((s) => s.side === "blue" && s.status === "ok").length} / ` +
      `RED ${wBattle.soldiers.filter((s) => s.side === "red" && s.status === "ok").length}、` +
      `接触 ${battleView.known} 件、屋内 ${indoor} 名`,
  );
}

main();
