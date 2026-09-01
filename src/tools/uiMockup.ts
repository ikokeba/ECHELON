/**
 * UIモックアップ生成(`[v6.5]`、`[v6.6]` でUIレビュー v2 を反映)。
 *
 * **デザイナーに渡すための1枚もののHTML**を書き出す。中隊 vs 中隊の代表的な2画面
 * ——「作戦立案(開始前)」と「戦闘中(約3分)」—— を、実際のシミュレーションから
 * 取った本物の状態で再現する。手描きのモックではないので、部隊の密度・建物の数・
 * 情報量が実物と一致している(そこがずれたモックは、たいてい実装で破綻する)。
 *
 * 地図はインラインSVG、HUDは実際のアプリと**同じクラス名**のHTML、色は
 * `src/theme.ts` から流し込んだ `:root` の変数。書体だけWebフォントを読むが、
 * 取れなければ system-ui に落ちる(描画は止めない読み込み方にしてある)。
 *
 * 実行: `npm run mockup` → `docs/design/ui-mockup-company.html`
 *
 * 反映の手順(デザイナー → 実装):
 *   - 色を変えた → `src/theme.ts` の1箇所だけ(地図もHUDもここを読む)
 *   - レイアウトを変えた → `src/ui/styles.css` の該当クラス
 *   - 記号の形・大きさを変えた → `src/render/renderer.ts` のジオメトリと
 *     `src/ui/Legend.tsx` の凡例グリフ(この2つは対で維持する)
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
import { PALETTE, themeCssVars } from "../theme.ts";
import type { AABB, Side, Soldier, Vec2 } from "../sim/types.ts";

const OUT = "docs/design/ui-mockup-company.html";
/** 戦闘画面を切り出す時刻(秒)。遭遇戦が始まり、負傷者と担架班が出ている頃 */
const BATTLE_SEC = 180;

// ── トークンの寸法。renderer.ts と同じ比で持つ ────────────────────────────
const TOKEN_R = SOLDIER_RADIUS * 1.6;
const BODY_RING_IN = 0.56;
const HALO_RING_IN = 1.12;
const HALO_RING_OUT = 1.44;
const KIA_ARM = 1.15;
const KIA_THICK = 0.3;
const BAR_SHORT = 0.6;
const BAR_LONG = 0.92;
const BAR_THICK = 0.15;
const BAR_GAP = 0.13;
/** 影のずれ m(renderer.ts の SHADOW_DX / SHADOW_DZ と同値) */
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

/** 階級(指揮継承の結果から引く。renderer.ts と同じ)。 */
type Rank = "co" | "pl" | "sq" | "ft";
function rankOf(world: World): Map<number, Rank> {
  const m = new Map<number, Rank>();
  for (const s of world.soldiers) if (s.isFireteamLeader) m.set(s.id, "ft");
  for (const sq of world.squads) if (sq.commanderId !== null) m.set(sq.commanderId, "sq");
  for (const pl of world.platoons) if (pl.commanderId !== null) m.set(pl.commanderId, "pl");
  for (const co of world.companies) if (co.commanderId !== null) m.set(co.commanderId, "co");
  return m;
}
const RANK_SHAPE: Record<Rank, { bars: number; long: boolean }> = {
  ft: { bars: 1, long: false },
  sq: { bars: 2, long: false },
  pl: { bars: 2, long: true },
  co: { bars: 3, long: true },
};

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

  g(
    "m-ground",
    `<rect x="${n(b.minX)}" y="${n(b.minZ)}" width="${n(W)}" height="${n(H)}" fill="var(--ground)"/>` +
      `<rect x="${n(b.minX)}" y="${n(b.minZ)}" width="${n(W)}" height="${n(H)}" fill="url(#sand)"/>`,
  );

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

  g(
    "m-floor",
    world.buildings
      .flatMap((bd) =>
        bd.rooms.map(
          (r) =>
            `<rect x="${n(r.bounds.minX)}" y="${n(r.bounds.minZ)}" ` +
            `width="${n(r.bounds.maxX - r.bounds.minX)}" height="${n(r.bounds.maxZ - r.bounds.minZ)}" ` +
            `fill="${tint(PALETTE.roomFloor, bd.id, 0.16)}"/>`,
        ),
      )
      .join(""),
  );

  g(
    "m-wall",
    world.structuralWalls
      .map((w) => {
        const bid = buildingIdOfWall(world, w);
        const fill = bid !== null ? tint(PALETTE.wall, bid, 0.14) : "var(--clutter)";
        return `<rect x="${n(w.cx - w.hw)}" y="${n(w.cz - w.hd)}" width="${n(w.hw * 2)}" height="${n(w.hd * 2)}" fill="${fill}"/>`;
      })
      .join(""),
  );

  // 扉。突入口なので、地形の中で唯一明度を上げてある
  g(
    "m-door",
    world.doors
      .map((d) => {
        const alongX = Math.abs(d.normal.x) > Math.abs(d.normal.z);
        const w = alongX ? 0.35 : d.width;
        const h = alongX ? d.width : 0.35;
        const fill = d.open ? "var(--door-open)" : "var(--door-closed)";
        return `<rect x="${n(d.pos.x - w / 2)}" y="${n(d.pos.z - h / 2)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
      })
      .join(""),
  );

  g(
    "m-ccp",
    (["blue", "red"] as Side[])
      .map((side) => {
        const p = world.ccp[side];
        const c = side === "blue" ? "var(--blue)" : "var(--red)";
        return (
          `<circle cx="${n(p.x)}" cy="${n(p.z)}" r="${n(LITTER.EVAC_RADIUS)}" fill="none" stroke="${c}" stroke-width="0.45" opacity="0.6"/>` +
          `<path d="M ${n(p.x - 0.8)} ${n(p.z)} h 1.6 M ${n(p.x)} ${n(p.z - 0.8)} v 1.6" stroke="${PALETTE.text}" stroke-width="0.5" opacity="0.85"/>`
        );
      })
      .join(""),
  );

  // 敵接触(報告された最終目撃位置 + 破線の不確度円)。仕様 §5
  if (view.enemies.length) {
    g(
      "m-contact",
      view.enemies
        .map((e) => {
          const c = e.confidence <= 0 ? "var(--ghost)" : "var(--red)";
          const r = SOLDIER_RADIUS * 2;
          return (
            `<circle cx="${n(e.pos.x)}" cy="${n(e.pos.z)}" r="${n(Math.max(0.4, e.posError))}" ` +
            `fill="none" stroke="${c}" stroke-width="0.35" stroke-dasharray="1.6 1.4" opacity="0.55"/>` +
            `<rect x="${n(e.pos.x - r / 2)}" y="${n(e.pos.z - r / 2)}" width="${n(r)}" height="${n(r)}" ` +
            `transform="rotate(45 ${n(e.pos.x)} ${n(e.pos.z)})" fill="${c}" fill-opacity="0.5" ` +
            `stroke="${c}" stroke-width="0.22"/>`
          );
        })
        .join(""),
    );
  }

  // 発砲線。実際には0.11秒で消えるので、静止画では実物より賑やかに見える
  const tracers = world.fx.filter((f) => f.kind === "shot");
  if (tracers.length) {
    g(
      "m-tracer",
      tracers
        .map((f) =>
          f.kind === "shot"
            ? `<line x1="${n(f.from.x)}" y1="${n(f.from.z)}" x2="${n(f.to.x)}" y2="${n(f.to.z)}" ` +
              `stroke="${f.hit ? PALETTE.rank : PALETTE.faint}" stroke-width="0.3" opacity="0.8"/>`
            : "",
        )
        .join(""),
    );
  }

  // ── 兵士。UIレビュー 04 の3層(陣営 × 状態 × 階級)──
  const ranks = rankOf(world);
  const tokens: Soldier[] = opts.showEnemyTruth
    ? view.friendly.concat(view.enemiesTruth)
    : view.friendly;
  const shadows: string[] = [];
  const bodies: string[] = [];
  const marks: string[] = [];
  const relations: string[] = [];
  const byId = new Map(world.soldiers.map((s) => [s.id, s]));

  for (const s of tokens) {
    if (isOffField(s)) continue;
    const dead = s.status === "kia";
    const wounded = s.status === "wia";
    const bearer = s.status === "ok" && s.bearing !== null;
    const suppressed = s.status === "ok" && s.suppressedUntilTick > world.tick;
    const side = s.side === "blue" ? "var(--blue)" : "var(--red)";

    shadows.push(
      `<circle cx="${n(s.pos.x + SHADOW_DX * 0.09)}" cy="${n(s.pos.z + SHADOW_DZ * 0.09)}" ` +
        `r="${n(TOKEN_R * (dead ? 0.64 : 1.06))}"/>`,
    );

    if (dead) {
      // 戦死: 円をやめて暗い×
      const a = TOKEN_R * KIA_ARM;
      const t = TOKEN_R * KIA_THICK;
      bodies.push(
        `<g transform="translate(${n(s.pos.x)} ${n(s.pos.z)})" fill="var(--kia)">` +
          `<rect x="${n(-a)}" y="${n(-t)}" width="${n(a * 2)}" height="${n(t * 2)}" transform="rotate(45)"/>` +
          `<rect x="${n(-a)}" y="${n(-t)}" width="${n(a * 2)}" height="${n(t * 2)}" transform="rotate(-45)"/>` +
          `</g>`,
      );
      continue;
    }

    // 芯。状態で色を置き換えるのは負傷だけ(制圧は外周リングで示す)
    const core = wounded ? (s.stabilized ? "var(--safe)" : "var(--shadow)") : side;
    bodies.push(`<circle cx="${n(s.pos.x)}" cy="${n(s.pos.z)}" r="${n(TOKEN_R)}" fill="${core}"/>`);

    // 状態リング: 負傷 = 黄の抜き円 / 担架要員 = 水色の内リング
    if (wounded || bearer) {
      const mid = TOKEN_R * (1 + BODY_RING_IN) * 0.5;
      const th = TOKEN_R * (1 - BODY_RING_IN);
      bodies.push(
        `<circle cx="${n(s.pos.x)}" cy="${n(s.pos.z)}" r="${n(mid)}" fill="none" ` +
          `stroke="${wounded ? "var(--warn)" : "var(--live)"}" stroke-width="${n(th)}"/>`,
      );
    }

    // 制圧: 陣営色は保ったまま、外周に白い輪
    if (suppressed) {
      const mid = TOKEN_R * (HALO_RING_IN + HALO_RING_OUT) * 0.5;
      const th = TOKEN_R * (HALO_RING_OUT - HALO_RING_IN);
      bodies.push(
        `<circle cx="${n(s.pos.x)}" cy="${n(s.pos.z)}" r="${n(mid)}" fill="none" ` +
          `stroke="var(--suppress)" stroke-width="${n(th)}" opacity="0.9"/>`,
      );
    }

    // 搬送は2名の関係なので線で結ぶ
    if (bearer && s.bearing !== null) {
      const cas = byId.get(s.bearing);
      if (cas) {
        relations.push(
          `<line x1="${n(s.pos.x)}" y1="${n(s.pos.z)}" x2="${n(cas.pos.x)}" y2="${n(cas.pos.z)}" ` +
            `stroke="var(--live)" stroke-width="0.28" opacity="0.85"/>`,
        );
      }
    }

    // 階級 = 円の上の横棒。本数と長さで4階級
    const rank = s.status === "ok" ? ranks.get(s.id) : undefined;
    if (rank) {
      const { bars, long } = RANK_SHAPE[rank];
      const len = TOKEN_R * 2 * (long ? BAR_LONG : BAR_SHORT);
      const th = TOKEN_R * 2 * BAR_THICK;
      const gap = TOKEN_R * 2 * BAR_GAP;
      for (let q = 0; q < bars; q++) {
        const y = s.pos.z - TOKEN_R - gap - th / 2 - q * (th + gap * 0.6);
        marks.push(
          `<rect x="${n(s.pos.x - len / 2)}" y="${n(y - th / 2)}" width="${n(len)}" height="${n(th)}" fill="var(--rank)"/>`,
        );
      }
    }
  }
  g("m-soldier-shadow", shadows.join(""));
  g("m-relation", relations.join(""));
  g("m-soldier", bodies.join(""));
  g("m-rank", marks.join(""));

  // 拠点。**接近経路より後に描く** — 矢羽根が目標に重なるので、標が下敷きになると
  // どこが拠点か読めなくなる(実装側は renderOrder で同じ順序にしてある)
  const objPin = 5;
  const objLayer = (): void =>
    g(
      "m-obj",
      world.objectives
        .map((o) => {
          const owner = o.owner ?? o.progressBy;
          const c = o.contested
            ? "var(--warn)"
            : owner
              ? owner === "blue"
                ? "var(--blue)"
                : "var(--red)"
              : "var(--safe)";
          const fillR = Math.max(0.001, o.progress * o.radius);
          return (
            `<circle cx="${n(o.pos.x)}" cy="${n(o.pos.z)}" r="${n(o.radius)}" fill="none" stroke="${c}" stroke-width="0.55" opacity="0.9"/>` +
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
      const c = r.side === "blue" ? "var(--blue)" : "var(--red)";
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
      // 矢羽根は目標の手前で止める(拠点の標を覆わないため。実装と同じ扱い)
      const dl = Math.hypot(e.x - a.x, e.z - a.z) || 1;
      const back = r.main ? 6.5 : 4.8;
      const ex = e.x - ((e.x - a.x) / dl) * back;
      const ez = e.z - ((e.z - a.z) / dl) * back;
      parts.push(
        `<path d="M ${n(ex)} ${n(ez + s)} L ${n(ex - s * 0.9)} ${n(ez - s * 0.7)} L ${n(ex + s * 0.9)} ${n(ez - s * 0.7)} Z" ` +
          `transform="rotate(${n(deg)} ${n(ex)} ${n(ez)})" fill="${c}" opacity="0.95"/>`,
      );
    }
    g("m-route", parts.join(""));
  }
  objLayer();

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

function rankBars(rank: Rank): string {
  const { bars, long } = RANK_SHAPE[rank];
  return `<span class="rank-bars ${long ? "rank-long" : "rank-short"}">${"<i></i>".repeat(bars)}</span>`;
}

function clockBar(world: World, planning: boolean): string {
  const controls = planning
    ? `<span class="tc-planning">作戦立案中 — 時間は止まっています</span>`
    : `<div class="tc-group">
        <button class="tc-btn">❚❚</button>
        <button class="tc-btn">×0.25</button><button class="tc-btn">×0.5</button>
        <button class="tc-btn tc-on">×1</button><button class="tc-btn">×2</button>
        <button class="tc-btn">×4</button><button class="tc-btn" disabled>⏭</button>
      </div>`;
  return `<div class="panel clockbar">
    <span class="clockbar-time">${clock(world.tick * SIM_DT)}</span>
    <span class="clockbar-tick">tick ${world.tick}</span>
    <span class="clockbar-sep"></span>${controls}</div>`;
}

function commandBanner(manual: boolean): string {
  return manual
    ? `<div class="panel panel-live cmdbanner cb-blue">
        <span class="cb-side">BLUE</span>
        <span class="cb-unit">1小隊長を操作中</span>
        <span class="cb-tag">MANUAL</span></div>`
    : `<div class="panel cmdbanner cb-idle">
        <span class="cb-unit">全ユニットAI制御</span>
        <span class="cb-view">視点: 小隊長</span></div>`;
}

function viewControls(view: ViewResult): string {
  const seg = (label: string, items: string[], on: number): string =>
    `<div class="seg-row"><span class="seg-label">${label}</span><div class="seg">` +
    items
      .map((t, i) => `<button class="seg-btn${i === on ? " seg-on" : ""}">${t}</button>`)
      .join("") +
    `</div></div>`;
  return `<div class="panel">
    ${seg("規模", ["分隊", "小隊", "中隊", "CQB"], 2)}
    ${seg("視点", ["中隊長", "小隊長", "分隊長", "神"], 1)}
    <div class="seg-row"><span class="seg-label">陣営</span><div class="seg">
      <button class="seg-btn seg-on seg-blue">BLUE</button><button class="seg-btn">RED</button>
    </div></div>
    <button class="btn">初期配置・拠点を編集</button>
    <div class="vc-hint">無線報告のみ。遅延と確度減衰あり(仕様 §5)</div>
    <div class="vc-contacts"><span>把握中の敵 <b>${view.known}</b></span><span>最終目撃 <b>${view.stale}</b></span></div>
  </div>`;
}

function forcePanel(world: World): string {
  const stat = (side: Side) => {
    const men = world.soldiers.filter((s) => s.side === side);
    return {
      eff: men.filter((s) => s.status === "ok").length,
      total: men.length,
      awaiting: men.filter((s) => s.status === "wia" && !isOffField(s)).length,
      carrying: men.filter((s) => s.evac === "carrying").length,
      kia: men.filter((s) => s.status === "kia").length,
    };
  };
  const blue = stat("blue");
  const red = stat("red");
  const row = (cls: string, label: string, s: ReturnType<typeof stat>): string =>
    `<div class="force-row force-${cls}"><span class="force-label">${label}</span>
      <span class="force-bar"><span style="width:${(s.eff / s.total) * 100}%"></span></span>
      <span class="force-num">${s.eff}<i>/${s.total}</i></span></div>`;
  return `<div class="panel">
    <div class="panel-cap"><span>FORCE</span></div>
    ${row("blue", "BLUE", blue)}${row("red", "RED", red)}
    <div class="force-detail"><span>後送待ち ${blue.awaiting}</span><span>搬送中 ${blue.carrying}</span><span>戦死 ${blue.kia}</span></div>
  </div>`;
}

function objectivePanel(world: World): string {
  return (
    `<div class="panel"><div class="panel-cap"><span>OBJECTIVES</span><span>過半数の保持で勝利</span></div>` +
    world.objectives
      .map((o) => {
        const cls = o.contested ? "contested" : (o.owner ?? "neutral");
        const state = o.contested
          ? "係争"
          : o.owner
            ? "確保"
            : o.progress > 0
              ? `${Math.round(o.progress * 100)}%`
              : "中立";
        return (
          `<div class="obj-row"><span class="obj-dot obj-${o.owner ?? "neutral"}"></span>` +
          `<span class="obj-label">${esc(o.label.replace("OBJ ", ""))}</span>` +
          `<span class="obj-bar"><span class="obj-fill obj-${cls}" style="width:${Math.round(o.progress * 100)}%"></span></span>` +
          `<span class="obj-state obj-${cls}">${state}</span></div>`
        );
      })
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
  const squads = world.squads.filter((s) => s.side === "blue").slice(0, 7);
  return (
    `<div class="panel panel-scroll">` +
    `<div class="panel-cap"><span>CONTEXT / 分隊の思考</span><span>BLUE</span></div>` +
    `<div class="tp-list">` +
    squads
      .map((sq) => {
        const fts = world.fireteams.filter((f) => f.side === "blue" && f.squadId === sq.squadId);
        return (
          `<div class="tp-squad${sq.assaultDoorId !== null ? " tp-squad-hot" : ""}">` +
          `<div class="tp-squad-head"><span class="tp-name">${sq.squadId}分隊</span>` +
          `<span class="tp-tech">${TECH_JP[sq.technique] ?? sq.technique}</span>` +
          (sq.assaultDoorId !== null ? `<span class="tp-tag tp-cqb">室内戦</span>` : "") +
          (sq.degradedSinceTick !== null ? `<span class="tp-tag tp-deg">継承中</span>` : "") +
          `</div>` +
          fts
            .map(
              (f) =>
                `<div class="tp-ft"><span class="tp-ft-name">FT${f.ftIndex}</span>` +
                `<span class="tp-mode">${FT_MODE_JP[f.mode] ?? f.mode}</span>` +
                `<span>[${f.assignedRole === "base" ? "制圧" : f.assignedRole === "maneuver" ? "機動" : "—"}]</span></div>`,
            )
            .join("") +
          `</div>`
        );
      })
      .join("") +
    `</div></div>`
  );
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
    `<div class="panel panel-warn plan-fit">` +
    `<div class="panel-cap"><span class="plan-title">作戦立案</span><span>開始まで時間は止まっています</span></div>` +
    `<div class="plan-force"><div class="plan-force-head force-blue"><span class="force-label">BLUE</span></div>` +
    `<div class="plan-intent">${esc(plan.intent)}</div>` +
    tasks
      .map(
        (t) =>
          `<div class="plan-task${t.role === "main" ? " plan-main" : ""}">` +
          `<span class="plan-role plan-role-${t.role}">${roleJp[t.role]}</span>` +
          `<span class="plan-unit">${platoonName(t.platoonId)}</span>` +
          `<span class="plan-unit">${missionJp[t.mission.kind]}</span>` +
          `<span class="plan-order">${esc(t.order)}</span></div>`,
      )
      .join("") +
    `</div>` +
    `<button class="plan-start">戦闘開始<span class="key-cap">Enter</span></button>` +
    `<div class="hint">配置(G)を変えると中隊長が立案し直します</div></div>`
  );
}

function echelonTree(world: World): string {
  const co = world.companies.find((c) => c.side === "blue")!;
  const men = (f: (s: Soldier) => boolean): string => {
    const l = world.soldiers.filter(f);
    return `${l.filter((s) => s.status === "ok").length}/${l.length}`;
  };
  const platoons = world.platoons.filter((p) => p.side === "blue" && p.companyId === co.companyId);
  return (
    `<div class="panel panel-scroll">` +
    `<div class="panel-cap"><span>ECHELON</span><span>クリックで交代</span></div>` +
    `<div class="et-list">` +
    `<button class="et-node et-on"><span class="et-name">観戦(全AI)</span></button>` +
    `<div class="et-list"><button class="et-node">${rankBars("co")}` +
    `<span class="et-name">${co.companyId}中隊</span>` +
    `<span class="et-strength">${men((s) => s.side === "blue")}</span></button>` +
    `<div class="et-assets">後送 ${co.assets.filter((a) => a.arriveTick === null).length}/${co.assets.length} 待機</div>` +
    `<div class="et-sub">` +
    platoons
      .map(
        (pl) =>
          `<div class="et-list"><button class="et-node">${rankBars("pl")}` +
          `<span class="et-name">${platoonName(pl.platoonId)}</span>` +
          `<span class="et-strength">${men((s) => s.side === "blue" && s.platoonId === pl.platoonId)}</span></button>` +
          `<div class="et-sub">` +
          world.squads
            .filter((q) => q.side === "blue" && q.platoonId === pl.platoonId)
            .map(
              (sq) =>
                `<button class="et-node et-leaf"><span class="et-name">${sq.squadId}分隊</span>` +
                (sq.degradedSinceTick !== null ? `<span class="et-deg"></span>` : "") +
                `<span class="et-strength">${men((s) => s.side === "blue" && s.squadId === sq.squadId)}</span></button>`,
            )
            .join("") +
          `</div></div>`,
      )
      .join("") +
    `</div></div></div></div>`
  );
}

const LEGEND = `<div class="panel legend">
  <div class="panel-cap"><span>LEGEND</span><span>凡例 L ／ デバッグ H ／ 配置 G ／ 一時停止 Space</span></div>
  <div class="lg-row"><span class="lg-cap">兵士</span>
    <span class="lg-item"><span class="lg-g lg-fill" style="background:var(--blue)"></span>健常</span>
    <span class="lg-item"><span class="lg-g lg-fill lg-halo" style="background:var(--blue)"></span>制圧</span>
    <span class="lg-item"><span class="lg-g lg-ring"></span>出血</span>
    <span class="lg-item"><span class="lg-g lg-ring-core"></span>止血済</span>
    <span class="lg-item"><span class="lg-g lg-fill lg-inner" style="background:var(--blue)"></span>担架班</span>
    <span class="lg-item"><span class="lg-g lg-line"></span>搬送</span>
    <span class="lg-item"><span class="lg-g lg-cross"></span>戦死</span></div>
  <div class="lg-row"><span class="lg-cap">標識</span>
    <span class="lg-item"><span class="lg-g lg-diamond"></span>最終目撃</span>
    <span class="lg-item"><span class="lg-g lg-dash"></span>不確度</span>
    <span class="lg-item"><span class="lg-g lg-obj"></span>拠点</span>
    <span class="lg-item"><span class="lg-g lg-obj" style="border-color:var(--text)"></span>操作中</span>
    <span class="lg-item"><span class="lg-g lg-obj" style="border-color:var(--live)"></span>選択・麾下</span>
    <span class="lg-item"><span class="lg-g lg-fill" style="background:var(--door-closed);border-radius:2px;width:5px"></span>閉じた扉</span></div>
  <div class="lg-row"><span class="lg-cap">階級</span>
    <span class="lg-item">${rankBars("ft")}FT長</span>
    <span class="lg-item">${rankBars("sq")}分隊長</span>
    <span class="lg-item">${rankBars("pl")}小隊長</span>
    <span class="lg-item">${rankBars("co")}中隊長</span></div>
</div>`;

function screen(
  title: string,
  note: string,
  world: World,
  view: ViewResult,
  opts: MapOpts,
  planning: boolean,
): string {
  return `<section class="shot">
  <h2>${esc(title)}</h2>
  <p class="shot-note">${esc(note)}</p>
  <div class="screen-slot"><div class="screen">
    ${mapSvg(world, view, opts)}
    <div class="hud">
      <div class="hud-col hud-col-l">
        ${viewControls(view)}
        <div class="hud-slot">${planning ? planPanel(world) : thinkingPanel(world)}</div>
        ${objectivePanel(world)}
      </div>
      <div class="hud-center">
        <div class="hud-rail">${clockBar(world, planning)}${commandBanner(!planning)}</div>
        <div class="hud-rail">${LEGEND}</div>
      </div>
      <div class="hud-col hud-col-r">
        ${forcePanel(world)}
        ${echelonTree(world)}
      </div>
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

  const vars = Object.entries(themeCssVars())
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>ECHELON — 中隊 vs 中隊 プレイ画面スナップショット</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@400;600;700&family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<style>
/*
 * ─────────────────────────────────────────────────────────────────────────
 * ECHELON UI スナップショット — デザイナー向け
 *
 * これは手描きのモックではなく、**実際のシミュレーションから取った本物の状態**を
 * そのまま描いたものです(建物 ${wBattle.buildings.length} 棟、両軍 ${wBattle.soldiers.length} 名、拠点 ${wBattle.objectives.length} 個)。
 * 情報量と密度が実物と一致しているので、ここで成立する配色・レイアウトはそのまま
 * 実装に載ります。
 *
 * 色は下の :root。**実装でもこの1箇所しかありません** — src/theme.ts が起動時に
 * 同じ変数を :root へ流し込み、地図の three.js も同じファイルの数値版を読みます。
 * 以前あった renderer.ts / styles.css の二重管理は解消済みです。
 *
 * クラス名は実装と同一なので、レイアウトの変更もそのまま移せます。
 * ─────────────────────────────────────────────────────────────────────────
 */
:root {
${vars}
  color-scheme: dark;
  --font-ui: "Noto Sans JP", system-ui, sans-serif;
  --font-display: "Barlow Semi Condensed", "Noto Sans JP", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
  --col-w: 300px;
  --gap: 16px;
  --pad: 24px;
  font-family: var(--font-ui);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); padding: 24px; -webkit-font-smoothing: antialiased; }
h1 { font-family: var(--font-display); font-size: 26px; letter-spacing: 0.04em; margin: 0 0 6px; }
h2 { font-family: var(--font-display); font-size: 18px; letter-spacing: 0.06em; color: var(--warn); margin: 34px 0 4px; }
.lead, .shot-note { color: var(--muted); font-size: 12.5px; line-height: 1.8; max-width: 1100px; margin: 0 0 10px; }
code { font-family: var(--font-mono); color: var(--text-dim); }
.shot { --k: 1; max-width: 1920px; }
.screen-slot { height: calc(1080px * var(--k)); overflow: hidden; }
.screen {
  position: relative; width: 1920px; height: 1080px;
  transform: scale(var(--k)); transform-origin: top left;
  background: var(--out-of-play); border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
}
.map { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.m-shadow rect { fill: var(--shadow); opacity: 0.3; }
.m-soldier-shadow circle { fill: var(--shadow); opacity: 0.42; }

/* ── 以下は src/ui/styles.css からの抜粋。クラス名は実装と同一 ── */
.hud { position: absolute; inset: 0; padding: var(--pad); display: flex; gap: var(--pad); }
.hud-col { width: var(--col-w); flex: none; min-height: 0; display: flex; flex-direction: column; gap: var(--gap); }
.hud-slot { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.hud-center { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; align-items: center; gap: var(--gap); }
.hud-rail { display: flex; align-items: center; gap: var(--gap); flex-wrap: wrap; justify-content: center; max-width: 100%; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; backdrop-filter: blur(8px); display: flex; flex-direction: column; gap: 9px; font-size: 12px; }
.panel-warn { border-color: var(--warn); box-shadow: 0 6px 28px rgba(0,0,0,0.45); }
.panel-live { border-color: var(--live); }
.panel-cap { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--faint); display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.panel-scroll { flex: 1; min-height: 0; overflow: hidden; }
.plan-fit { max-height: 100%; overflow: hidden; }
.seg-row { display: flex; align-items: center; gap: 8px; }
.seg-label { font-size: 11px; color: var(--muted); width: 30px; flex: none; }
.seg { flex: 1; display: flex; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 2px; gap: 2px; min-width: 0; }
.seg-btn { flex: 1; min-width: 0; background: transparent; color: var(--muted); border: 0; border-radius: 5px; padding: 5px 0; font-size: 11px; font-family: inherit; white-space: nowrap; }
.seg-on { background: var(--surface-hi); color: var(--warn); font-weight: 700; }
.seg-on.seg-blue { background: rgba(74,140,230,0.18); color: var(--blue); }
.btn { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 12px; font-family: inherit; }
.hint { color: var(--faint); font-size: 10.5px; line-height: 1.6; }
.rank-bars { display: flex; flex-direction: column; gap: 2px; flex: none; align-items: center; }
.rank-bars i { display: block; height: 2px; background: var(--rank); border-radius: 1px; }
.rank-short i { width: 9px; }
.rank-long i { width: 14px; }
.clockbar { flex-direction: row; align-items: center; gap: 14px; padding: 10px 14px; }
.clockbar-time { font-family: var(--font-mono); font-size: 22px; font-weight: 600; }
.clockbar-tick { font-family: var(--font-mono); font-size: 11px; color: var(--faint); }
.clockbar-sep { width: 1px; height: 22px; background: var(--border); flex: none; }
.tc-group { display: flex; gap: 4px; }
.tc-btn { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; font-size: 12px; font-family: var(--font-mono); }
.tc-btn:disabled { color: var(--faint); }
.tc-on { background: var(--surface-hi); border-color: var(--warn); color: var(--warn); }
.tc-planning { color: var(--warn); font-size: 12px; letter-spacing: 0.04em; }
.cmdbanner { flex-direction: row; align-items: center; gap: 10px; padding: 9px 18px; border-radius: 999px; white-space: nowrap; font-size: 13px; }
.cb-idle { opacity: 0.7; }
.cb-side { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.14em; font-size: 11px; }
.cb-blue .cb-side { color: var(--blue); }
.cb-unit { font-weight: 600; }
.cb-tag { font-family: var(--font-mono); font-size: 10px; color: var(--live); }
.cb-view { color: var(--muted); font-size: 11px; }
.vc-hint { font-size: 10.5px; line-height: 1.55; color: var(--faint); border-top: 1px solid var(--border); padding-top: 8px; }
.vc-contacts { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.vc-contacts b { color: var(--text); font-family: var(--font-mono); }
.plan-title { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.18em; color: var(--warn); font-size: 14px; }
.plan-force { display: flex; flex-direction: column; gap: 4px; }
.plan-force-head { display: flex; align-items: baseline; gap: 8px; }
.plan-intent { color: var(--muted); font-size: 11px; line-height: 1.6; }
.plan-task { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 6px 8px; border-radius: 6px; border: 1px solid transparent; }
.plan-main { border-color: var(--warn); background: rgba(242,179,42,0.08); }
.plan-role { flex: none; width: 36px; text-align: center; font-family: var(--font-mono); font-size: 10px; font-weight: 700; border-radius: 3px; padding: 2px 0; background: var(--surface); color: var(--muted); }
.plan-role-main { background: #5a3a10; color: var(--warn); }
.plan-role-supporting { background: var(--surface-hi); color: var(--text); }
.plan-unit { flex: none; color: var(--muted); font-size: 11px; }
.plan-order { flex: 1 1 100%; font-size: 12px; line-height: 1.55; color: var(--text-dim); }
.plan-main .plan-order { color: var(--text); }
.plan-start { background: #5a3a10; color: var(--warn); border: 1px solid var(--warn); border-radius: 8px; padding: 9px 18px; font-size: 14px; font-weight: 700; font-family: inherit; display: flex; align-items: center; justify-content: center; gap: 8px; }
.key-cap { font-family: var(--font-mono); font-size: 10px; font-weight: 400; opacity: 0.75; border: 1px solid currentColor; border-radius: 3px; padding: 1px 5px; }
.tp-list { display: flex; flex-direction: column; gap: 10px; font-size: 11.5px; }
.tp-squad { border-left: 2px solid var(--border); padding-left: 8px; }
.tp-squad-hot { border-left-color: var(--warn); }
.tp-squad-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tp-name { font-weight: 700; }
.tp-tech { color: var(--muted); }
.tp-tag { font-family: var(--font-mono); font-size: 9px; padding: 1px 5px; border-radius: 3px; }
.tp-cqb { background: #3a2f14; color: var(--warn); }
.tp-deg { background: #4a2020; color: #ff9a8a; }
.tp-ft { display: flex; gap: 8px; color: var(--muted); padding-left: 6px; margin-top: 3px; }
.tp-ft-name { width: 34px; flex: none; }
.tp-mode { color: var(--text); }
.obj-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.obj-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.obj-label { width: 68px; flex: none; color: var(--text-dim); font-family: var(--font-mono); letter-spacing: 0.06em; }
.obj-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--surface); overflow: hidden; display: flex; }
.obj-fill { display: block; height: 100%; }
.obj-state { font-family: var(--font-mono); font-size: 11px; width: 34px; text-align: right; flex: none; color: var(--faint); }
.obj-neutral { background: var(--safe); }
.obj-blue { background: var(--blue); }
.obj-red { background: var(--red); }
.obj-contested { background: var(--warn); }
.obj-state.obj-blue, .obj-state.obj-red, .obj-state.obj-contested, .obj-state.obj-neutral { background: none; }
.obj-state.obj-blue { color: var(--blue); }
.obj-state.obj-contested { color: var(--warn); }
.force-row { display: flex; align-items: center; gap: 10px; }
.force-label { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.14em; font-size: 13px; width: 42px; flex: none; }
.force-blue .force-label { color: var(--blue); }
.force-red .force-label { color: var(--red); }
.force-bar { flex: 1; height: 4px; background: var(--surface); border-radius: 2px; overflow: hidden; }
.force-bar span { display: block; height: 100%; }
.force-blue .force-bar span { background: var(--blue); }
.force-red .force-bar span { background: var(--red); }
.force-num { font-family: var(--font-mono); font-size: 12px; flex: none; }
.force-num i { color: var(--faint); font-style: normal; }
.force-detail { display: flex; gap: 14px; font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 7px; }
.et-list { display: flex; flex-direction: column; gap: 3px; }
.et-sub { display: flex; flex-direction: column; gap: 3px; margin: 3px 0 3px 6px; padding-left: 12px; border-left: 1px solid var(--border); }
.et-node { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; text-align: left; }
.et-leaf { background: var(--surface-lo); color: var(--text-dim); font-size: 11.5px; padding: 5px 8px; }
.et-on { border-color: var(--warn); color: var(--warn); background: #3a2f14; font-weight: 700; }
.et-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.et-strength { font-family: var(--font-mono); font-size: 11px; color: var(--muted); flex: none; }
.et-deg { width: 6px; height: 6px; border-radius: 50%; background: var(--warn); flex: none; }
.et-assets { font-family: var(--font-mono); font-size: 10px; color: var(--faint); padding-left: 2px; }
.legend { width: 100%; max-width: 940px; gap: 6px; padding: 9px 14px; }
.lg-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 11px; }
.lg-cap { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.16em; color: var(--faint); width: 30px; flex: none; }
.lg-item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.lg-g { width: 12px; height: 12px; flex: none; display: inline-block; position: relative; }
.lg-fill { border-radius: 50%; }
.lg-ring { border-radius: 50%; border: 3px solid var(--warn); }
.lg-ring-core { border-radius: 50%; border: 3px solid var(--warn); background: var(--safe); }
.lg-halo { border-radius: 50%; box-shadow: 0 0 0 2px var(--suppress); transform: scale(0.76); }
.lg-inner { border-radius: 50%; box-shadow: inset 0 0 0 3px var(--live); }
.lg-cross::before, .lg-cross::after { content: ""; position: absolute; left: 0; top: 5px; width: 12px; height: 3px; background: var(--kia); }
.lg-cross::before { transform: rotate(45deg); }
.lg-cross::after { transform: rotate(-45deg); }
.lg-diamond { width: 9px; height: 9px; transform: rotate(45deg); border: 2px solid var(--red); }
.lg-dash { border-radius: 50%; border: 2px dashed var(--ghost); }
.lg-obj { border-radius: 50%; border: 2px solid var(--safe); }
.lg-line { height: 3px; align-self: center; background: var(--live); }
button { font-family: inherit; cursor: default; }
</style>
</head>
<body>
<h1>ECHELON — 中隊 vs 中隊 プレイ画面スナップショット</h1>
<p class="lead">
  自動生成(<code>npm run mockup</code> / <code>src/tools/uiMockup.ts</code>)。手描きのモックではなく、
  <b>実際のシミュレーションから取った本物の状態</b>です — 建物 ${wBattle.buildings.length} 棟、両軍 ${wBattle.soldiers.length} 名、拠点 ${wBattle.objectives.length} 個。<br>
  UIレビュー v2 を反映済み: <b>3列 + 2レール</b>のレイアウト(絶対座標を廃止)、<b>色の単一ソース化</b>
  (<code>src/theme.ts</code> だけが色を持ち、地図もHUDもここを読む)、
  <b>兵士記号の3層化</b>(陣営 × 状態 × 階級。状態は色ではなく塗り／抜き／輪で分ける)。
</p>

${screen(
  "① 作戦立案(戦闘開始前)",
  "中隊長が拠点に対する計画を立てた直後。矢印が各小隊の接近経路で、太いものが主攻。左列L2の文脈スロットを作戦パネルが占有し、分隊思考は出ません。時間は止まっており、「戦闘開始」を押すまで1ティックも進みません。この画面だけは敵の初期配置も見えます(まだ戦闘ではなく盤面の設定のため)。",
  wPlan,
  planView,
  { routes, showEnemyTruth: true },
  true,
)}

${screen(
  `② 戦闘中(${BATTLE_SEC} 秒経過)`,
  `BLUE 1小隊長の視点。敵は実体ではなく「報告された最終目撃位置」(菱形)と破線の不確度円で出ます — 見えているものしか見えないのが本作の中心です。この時点で屋内にいる兵士 ${indoor} 名、把握している敵接触 ${battleView.known} 件(うち確度切れ ${battleView.stale} 件)。長い細線は発砲線で、実機では0.11秒で消えるため静止画では実物より賑やかに見えます。`,
  wBattle,
  battleView,
  { showEnemyTruth: false },
  false,
)}

<h2>レビューからの変更点</h2>
<ol class="lead">
  <li><b>診断A(左列の衝突)</b> — HUDを3列+2レールのflexにし、絶対座標を全廃。左列L2は
      「作戦立案 / 分隊の思考」のどちらか1つだけが入る文脈スロットになりました。</li>
  <li><b>診断B(制圧と負傷が同じ明色帯)</b> — 制圧は<b>色を置き換えず</b>、陣営色のまま外周に
      白リングを足す方式へ。負傷は黄の抜き円なので、色ではなく形で分かれます。</li>
  <li><b>診断C(担架班と負傷者が同色)</b> — 運ぶ側は陣営色+水色の内リング、運ばれる側は負傷記号のまま、
      2点を水色の線で結びます。搬送を「関係」として描くようにしました。</li>
  <li><b>診断D(階級章が弱い)</b> — 点と棒の混在をやめ、円の上の横棒の<b>本数と長さ</b>だけに。
      同じ記号を階層ツリーでも使っています。</li>
  <li><b>縮尺による間引き</b> — トークン直径 6px / 3px の2しきい値を1箇所で判定。
      遠景では健常・負傷・戦死の3段だけが残ります。</li>
</ol>

<h2>実装からの申し送り</h2>
<p class="lead">
  <b>発砲線の扱いだけ案から外しました。</b> 案では「近(≥6px)」の層に置かれていましたが、
  盤面全体を見る縮尺でも残しています — 引きの絵で「いまどこで戦っているか」を示す唯一の手段で、
  これを落とすと戦闘中の全体像が静止画のように見えるためです。兵士の記号ではなく
  <b>一時的な事象の層</b>として、拠点標・選択リング・命令線と同じ「常時」に入れました。
</p>
<p class="lead">
  <b>未検証だった「制圧の白リングが密集時に隣接兵と融合するか」は実データで計測しました。</b>
  リング外周(0.81m)が隣人のトークン(0.56m)に触れる距離は 1.37m。被制圧の全標本のうち
  この距離を割っていたのは <b>8%程度</b>で、86%は 2m 以上離れていました。融合は起こりますが
  常時ではないので、現状のまま進めます。CQB(屋内)の最密部は計測窓のあいだ標本が取れず、
  引き続きプレイテストで確認します。
</p>
<script>
// 1920×1080 の画面を、ウィンドウ幅に合わせて等倍縮小するだけ。
// 拡大して細部を見たいときは、この行を消すか --k を固定値にしてください。
// (CSSのcalcでは length / length が書けないので、ここだけスクリプトで行っています)
function fit() {
  var k = Math.min(1, (document.documentElement.clientWidth - 56) / 1920);
  for (var el of document.querySelectorAll(".shot")) el.style.setProperty("--k", k);
}
fit();
addEventListener("resize", fit);
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
