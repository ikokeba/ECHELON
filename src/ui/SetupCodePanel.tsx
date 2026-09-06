import { useRef, useState } from "react";
import { useSimStore } from "./store.ts";

/**
 * 初期条件コード(`[v6.18]`)。
 *
 * **この戦闘を作った条件をひと固まりの文字列にして、貼れば同じ盤面が出るようにする。**
 * 動作確認で見つけた挙動を後から検証するときに、盤面・種・編成・ドクトリン・
 * リスク許容度・共通パラメータ・配置を口頭で復元しなくて済む。
 *
 * URL の `#` にも同じコードを載せるので、**その URL を LAN 内のスマホで開けば
 * 同じ条件が再現される**。動作確認をPCとスマホで突き合わせるための導線。
 *
 * 再現できないのは初期条件でないもの — 人間の操作(ホットスワップ・移動命令)と、
 * 戦闘の**最中**にスライダーを動かすこと。そこは注記として画面にも出す。
 */
export function SetupCodePanel() {
  const seed = useSimStore((s) => s.seed);
  const setSeed = useSimStore((s) => s.setSeed);
  const applySetupCode = useSimStore((s) => s.applySetupCode);
  /**
   * コードは**描画のたびに導く**。`setupCode()` は副作用を持たない読み取りなので
   * これでよい。
   *
   * 一度 `useSimStore((s) => [ ...初期条件のフィールド ])` で1本のセレクタにまとめた
   * ところ、**配列が毎回新しい参照になって zustand のスナップショットが安定せず**、
   * React が更新を打ち切って画面が真っ白になった("getSnapshot should be cached")。
   * セレクタは必ず安定した値を返すものだけにする。
   */
  useSimStore((s) => s.scenarioKey);
  useSimStore((s) => s.force);
  useSimStore((s) => s.doctrine);
  useSimStore((s) => s.posture);
  useSimStore((s) => s.tuning);
  useSimStore((s) => s.deployment);
  const code = useSimStore.getState().setupCode();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | null>(null);

  const flash = (msg: string) => {
    setNote(msg);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2400);
  };

  const copy = async () => {
    const link = `${window.location.origin}${window.location.pathname}#${code}`;
    try {
      await navigator.clipboard.writeText(link);
      flash("URLをコピーしました");
    } catch {
      // https でない LAN 越しだと clipboard API が使えない。選択状態にして手動コピーへ
      flash("コピーできません。文字列を選んでコピーしてください");
    }
  };

  const apply = () => {
    if (applySetupCode(draft.trim())) {
      setDraft("");
      flash("初期条件を読み込みました");
    } else {
      flash("読めないコードです");
    }
  };

  return (
    <div className="panel setup-code">
      <div className="panel-cap">
        <span>初期条件コード</span>
        <span className="cap-hint">貼れば同じ戦闘</span>
      </div>

      <label className="setup-row">
        <span>乱数種</span>
        <input
          type="number"
          min={0}
          step={1}
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value))}
        />
        <button type="button" onClick={() => setSeed(seed + 1)} title="次の種で作り直す">
          次へ
        </button>
      </label>

      <div className="setup-code-box" title="この戦闘の初期条件。両陣営に同じ種が入る(仕様 §2/§13)">
        <code>{code}</code>
      </div>
      <div className="setup-actions">
        <button type="button" onClick={() => void copy()}>
          URLをコピー
        </button>
      </div>

      <div className="setup-actions">
        <input
          type="text"
          placeholder="コードを貼る"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
        />
        <button type="button" onClick={apply} disabled={draft.trim().length === 0}>
          読込
        </button>
      </div>

      {note && <div className="setup-note">{note}</div>}
      <div className="setup-hint">
        再現されるのは初期条件だけ。操作(交代・移動命令)と、戦闘中のスライダー変更は
        含まれません。
      </div>
    </div>
  );
}
