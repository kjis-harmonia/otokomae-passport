import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./premium-gacha.css";

/* ============================================================
   Types
   ============================================================ */

export type GachaRank = "BRONZE" | "SILVER" | "GOLD" | "PLATINUM";

export interface GachaResult {
  rank: GachaRank;
  reward: string;
  memberId: string;
  drawnAt: string; // ISO timestamp
}

export interface PremiumGachaExperienceProps {
  /** Called when the user closes the experience after seeing the result. */
  onClose?: () => void;
  /** Called once a result is revealed. */
  onComplete?: (result: GachaResult) => void;
  /** Inject a deterministic result for testing / story branching. */
  forcedResult?: GachaRank;
  /** Override mock copy if needed. */
  rewardCopy?: Partial<Record<GachaRank, string>>;
}

type Phase = "sealed" | "breach" | "running" | "machine" | "result";

/* ============================================================
   Constants
   ============================================================ */

const SWIPE_THRESHOLD_PX = 60;
const BREACH_DURATION_MS = 720;
const RUNNING_DURATION_MS = 2000;
const BLOOM_DURATION_MS = 1100;

const IMG_SEALED = "/images/publicgacha01-sealed-door.png";
const IMG_RUNNING = "/images/publicgacha02-shrine-approach.png";
const IMG_MACHINE = "/images/publicgacha03-gacha-machine.png";

const DEFAULT_REWARD_COPY: Record<GachaRank, string> = {
  BRONZE: "Regular Reward\n通常特典",
  SILVER: "500円OFF Coupon\n五百円割引券",
  GOLD: "Premium Status\nプレミアム称号",
  PLATINUM: "Special Invitation\n特別招待状",
};

const RANK_KANJI: Record<GachaRank, string> = {
  BRONZE: "銅",
  SILVER: "銀",
  GOLD: "金",
  PLATINUM: "白金",
};

/* Weighted draw distribution */
const RANK_WEIGHTS: Array<{ rank: GachaRank; weight: number }> = [
  { rank: "BRONZE",   weight: 60 },
  { rank: "SILVER",   weight: 25 },
  { rank: "GOLD",     weight: 12 },
  { rank: "PLATINUM", weight:  3 },
];

function drawRank(): GachaRank {
  const total = RANK_WEIGHTS.reduce((acc, r) => acc + r.weight, 0);
  let n = Math.random() * total;
  for (const { rank, weight } of RANK_WEIGHTS) {
    if (n < weight) return rank;
    n -= weight;
  }
  return "BRONZE";
}

function generateMemberId(): string {
  const now = new Date();
  const ymd =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}`;
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `GJ-${ymd}-${rand}`;
}

/* ============================================================
   Reduced motion hook
   ============================================================ */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);

  return reduced;
}

/* ============================================================
   Gold-dust particle field (Phase 3)
   Generates a stable set of motes per mount.
   ============================================================ */

interface Mote {
  left: string;
  duration: string;
  delay: string;
  drift: string;
  size: string;
  opacity: number;
}

function buildMotes(count: number): Mote[] {
  const motes: Mote[] = [];
  for (let i = 0; i < count; i++) {
    const left = `${Math.random() * 100}%`;
    const duration = `${2.4 + Math.random() * 3.2}s`;
    const delay = `${Math.random() * 2.4}s`;
    const drift = `${(Math.random() - 0.5) * 60}px`;
    const sizePx = 1 + Math.random() * 2.2;
    motes.push({
      left,
      duration,
      delay,
      drift,
      size: `${sizePx.toFixed(2)}px`,
      opacity: 0.5 + Math.random() * 0.5,
    });
  }
  return motes;
}

/* ============================================================
   Component
   ============================================================ */

export default function PremiumGachaExperience({
  onClose,
  onComplete,
  forcedResult,
  rewardCopy,
}: PremiumGachaExperienceProps) {
  const [phase, setPhase] = useState<Phase>("sealed");
  const [result, setResult] = useState<GachaResult | null>(null);
  const [resultShown, setResultShown] = useState<boolean>(false);
  const [isPulsing, setIsPulsing] = useState<boolean>(false);

  const reducedMotion = usePrefersReducedMotion();
  const motes = useMemo(() => buildMotes(reducedMotion ? 0 : 28), [reducedMotion]);

  const swipeStartX = useRef<number | null>(null);
  const swipeFiredRef = useRef<boolean>(false);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const queueTimer = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timersRef.current.push(id);
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current = [];
  }, []);

  /* ----- Body lock ----- */
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.add("pg-active");
    return () => {
      document.body.classList.remove("pg-active");
      clearTimers();
    };
  }, [clearTimers]);

  /* ----- Phase orchestration helpers ----- */

  const triggerBreach = useCallback(() => {
    if (phase !== "sealed") return;
    swipeFiredRef.current = true;
    setPhase("breach");
    // After the breach finishes, switch to the running sequence.
    queueTimer(() => {
      setPhase("running");
      // Running zoom auto-advances to the machine phase.
      queueTimer(() => setPhase("machine"), RUNNING_DURATION_MS);
    }, BREACH_DURATION_MS);
  }, [phase, queueTimer]);

  /* ----- Phase 1: swipe handlers (Pointer Events cover mouse + touch) ----- */

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== "sealed") return;
    swipeStartX.current = e.clientX;
    swipeFiredRef.current = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== "sealed" || swipeStartX.current == null || swipeFiredRef.current) return;
    const dx = e.clientX - swipeStartX.current;
    if (Math.abs(dx) >= SWIPE_THRESHOLD_PX) {
      triggerBreach();
    }
  };

  const onPointerUp = () => {
    swipeStartX.current = null;
  };

  /* ----- Phase 4: lever pull ----- */

  const onPullLever = useCallback(() => {
    if (phase !== "machine" || isPulsing) return;
    setIsPulsing(true);

    // Resolve the result a beat before the bloom completes
    // so the card overlay can be ready to fade in.
    const rank: GachaRank = forcedResult ?? drawRank();
    const reward =
      (rewardCopy && rewardCopy[rank]) ?? DEFAULT_REWARD_COPY[rank];
    const resolved: GachaResult = {
      rank,
      reward,
      memberId: generateMemberId(),
      drawnAt: new Date().toISOString(),
    };

    queueTimer(() => {
      setResult(resolved);
      setPhase("result");
      // small tick to allow the result stage to mount before the .is-shown class.
      queueTimer(() => {
        setResultShown(true);
        onComplete?.(resolved);
      }, 40);
    }, BLOOM_DURATION_MS - 220);
  }, [forcedResult, isPulsing, onComplete, phase, queueTimer, rewardCopy]);

  /* ----- Close handler ----- */

  const handleClose = useCallback(() => {
    setResultShown(false);
    // give the fade-out time to play, then unmount via parent
    queueTimer(() => {
      onClose?.();
    }, 360);
  }, [onClose, queueTimer]);

  /* ============================================================
     Render
     ============================================================ */

  return (
    <div
      className="pg-root"
      role="dialog"
      aria-modal="true"
      aria-label="銀二郎 プレミアム抽選体験"
    >
      {/* ---------- PHASE 1 — Silent Gateway ---------- */}
      <section
        className={`pg-stage pg-stage--sealed ${phase === "sealed" ? "is-active" : ""}`}
        aria-hidden={phase !== "sealed"}
      >
        <img
          className="pg-stage__bg"
          src={IMG_SEALED}
          alt="封印された朱の門"
          draggable={false}
        />
        <div className="pg-lantern-glow" aria-hidden="true" />
        <div className="pg-vignette" aria-hidden="true" />

        <div className="pg-swipe-hint" aria-hidden="true">
          <div className="pg-swipe-track" />
          <div className="pg-swipe-text">
            横にスワイプして解放
            <span className="pg-swipe-arrow">›</span>
          </div>
        </div>

        <div
          className="pg-swipe-surface"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="button"
          tabIndex={0}
          aria-label="横にスワイプして封印を解く"
          onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (phase !== "sealed") return;
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
              e.preventDefault();
              triggerBreach();
            }
          }}
        />
      </section>

      {/* ---------- PHASE 2 — Breach ---------- */}
      {phase === "breach" && (
        <div className="pg-breach" aria-hidden="true">
          <span className="pg-breach__crimson" />
          <span className="pg-breach__shock" />
          <span className="pg-breach__gold" />
        </div>
      )}

      {/* ---------- PHASE 3 — Running ---------- */}
      <section
        className={`pg-stage pg-stage--running ${phase === "running" ? "is-active" : ""}`}
        aria-hidden={phase !== "running"}
      >
        <img
          className="pg-stage__bg"
          src={IMG_RUNNING}
          alt="参道を駆ける銀ちゃん"
          draggable={false}
        />
        <div className="pg-vignette" aria-hidden="true" />

        {phase === "running" && !reducedMotion && (
          <div className="pg-dust" aria-hidden="true">
            {motes.map((m, i) => {
              const style: CSSProperties = {
                left: m.left,
                width: m.size,
                height: m.size,
                animationDuration: m.duration,
                animationDelay: m.delay,
                opacity: m.opacity,
                ["--drift" as string]: m.drift,
              };
              return <span key={i} className="pg-dust__mote" style={style} />;
            })}
          </div>
        )}
      </section>

      {/* ---------- PHASE 4 — Machine ---------- */}
      <section
        className={`pg-stage pg-stage--machine ${phase === "machine" ? "is-active" : ""}`}
        aria-hidden={phase !== "machine"}
      >
        <img
          className="pg-stage__bg"
          src={IMG_MACHINE}
          alt="神聖なる祭具 — ガチャ機"
          draggable={false}
        />
        <div className="pg-vignette" aria-hidden="true" />
        <div className={`pg-bloom ${isPulsing ? "is-pulsing" : ""}`} aria-hidden="true" />

        {phase === "machine" && (
          <button
            type="button"
            className="pg-lever"
            onClick={onPullLever}
            disabled={isPulsing}
            aria-label="把手を引く"
          >
            <span className="pg-lever__corner tl" aria-hidden="true" />
            <span className="pg-lever__corner tr" aria-hidden="true" />
            <span className="pg-lever__corner bl" aria-hidden="true" />
            <span className="pg-lever__corner br" aria-hidden="true" />
            把手を引く
          </button>
        )}
      </section>

      {/* ---------- PHASE 5 — Result ---------- */}
      {result && (
        <div
          className={`pg-result ${resultShown ? "is-shown" : ""}`}
          role="alertdialog"
          aria-label="抽選結果"
        >
          <article className="pg-card">
            <div className="pg-card__kanji">男前証</div>
            <div className="pg-card__brand">GINJIRO</div>
            <div className="pg-card__divider" />

            <div className="pg-card__rank-label">Member Rank</div>
            <div className="pg-card__rank">{result.rank}</div>

            <div className="pg-card__seal" aria-hidden="true">
              {RANK_KANJI[result.rank]}
            </div>

            <div className="pg-card__reward-label">Reward</div>
            <div className="pg-card__reward">
              {result.reward.split("\n").map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>

            <div className="pg-card__id">{result.memberId}</div>
          </article>

          <button
            type="button"
            className="pg-result__action"
            onClick={handleClose}
          >
            受け取る
          </button>
        </div>
      )}
    </div>
  );
}
