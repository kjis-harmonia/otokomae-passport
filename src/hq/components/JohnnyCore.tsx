import { useEffect, useRef } from "react";

/**
 * JOHNNY の「コア」— 呼吸するホログラムの球。
 * 点の球（ゆっくり回る）・経線・軌道リング・走査する弧・中心の光・下の台座・立ちのぼる粒。
 * mode: idle＝ゆっくり呼吸（約4.2秒）/ thinking＝速く明るく。
 * 画面が隠れている間は止める。動きを減らす設定（data-motion="reduced" / prefers-reduced-motion）なら静止画。
 */
export type CoreMode = "idle" | "thinking";

interface Pt {
  x: number;
  y: number;
  z: number;
}

const CYAN = "95, 212, 255";
const BLUE = "40, 120, 255";

function fibonacciSphere(n: number): Pt[] {
  const pts: Pt[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r });
  }
  return pts;
}

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.dataset.motion === "reduced" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function JohnnyCore({ size = 320, mode = "idle", detail = "full", className }: { size?: number; mode?: CoreMode; detail?: "full" | "mini"; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<CoreMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.round(size * dpr);
    el.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const mini = detail === "mini";
    const sphere = fibonacciSphere(mini ? 140 : 520);
    const particles = Array.from({ length: mini ? 0 : 46 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), life: Math.random(), speed: 0.12 + Math.random() * 0.2 }));
    const c = size / 2;
    const R = size * (mini ? 0.3 : 0.24);
    const cy = mini ? c : c - size * 0.04;
    const tilt = 0.38;

    let raf = 0;
    let last = performance.now();
    let spin = 0;
    let energy = 0; // 0→1：考え中に近づくほど明るく速く
    let phase = 0;

    const project = (p: Pt, rot: number) => {
      const x1 = p.x * Math.cos(rot) + p.z * Math.sin(rot);
      const z1 = -p.x * Math.sin(rot) + p.z * Math.cos(rot);
      const y2 = p.y * Math.cos(tilt) - z1 * Math.sin(tilt);
      const z2 = p.y * Math.sin(tilt) + z1 * Math.cos(tilt);
      return { x: c + x1 * R, y: cy + y2 * R, z: z2 };
    };

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const target = modeRef.current === "thinking" ? 1 : 0;
      energy += (target - energy) * Math.min(dt * 2.5, 1);
      const period = 4.2 - energy * 2.8;
      phase += (dt / period) * Math.PI * 2;
      spin += dt * (0.16 + energy * 0.6);
      const b = 0.5 + 0.5 * Math.sin(phase); // 呼吸
      const t = now / 1000;
      draw(t, b, dt);
      raf = requestAnimationFrame(frame);
    };

    const draw = (t: number, b: number, dt: number) => {
      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = "lighter";

      // 外の光
      const glow = ctx.createRadialGradient(c, cy, R * 0.2, c, cy, R * 1.9);
      glow.addColorStop(0, `rgba(${CYAN}, ${0.16 + 0.12 * b + energy * 0.1})`);
      glow.addColorStop(0.5, `rgba(${BLUE}, ${0.06 + 0.05 * b})`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      // 縦の光の柱
      if (!mini) {
        const beam = ctx.createLinearGradient(0, 0, 0, size);
        beam.addColorStop(0, "rgba(0,0,0,0)");
        beam.addColorStop(0.5, `rgba(${CYAN}, ${0.18 + 0.2 * b})`);
        beam.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = beam;
        ctx.fillRect(c - 0.75, 0, 1.5, size);
      }

      // 台座（楕円の重なり＋目盛り）
      if (!mini) {
        const py = cy + R * 1.42;
        for (let i = 0; i < 4; i++) {
          const rx = R * (0.7 + i * 0.32);
          ctx.beginPath();
          ctx.ellipse(c, py, rx, rx * 0.17, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${CYAN}, ${(0.32 - i * 0.06) * (0.6 + 0.4 * b)})`;
          ctx.lineWidth = i === 0 ? 1.6 : 1;
          ctx.stroke();
        }
        const rx = R * 1.3;
        for (let k = 0; k < 48; k++) {
          const a = (k / 48) * Math.PI * 2 + t * 0.15;
          const x = c + Math.cos(a) * rx;
          const y = py + Math.sin(a) * rx * 0.17;
          ctx.fillStyle = `rgba(${CYAN}, ${0.25 + 0.35 * Math.max(0, Math.sin(a * 3 - t * 2))})`;
          ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
        }
        const pool = ctx.createRadialGradient(c, py, 0, c, py, R * 0.9);
        pool.addColorStop(0, `rgba(${CYAN}, ${0.22 + 0.18 * b})`);
        pool.addColorStop(1, "rgba(0,0,0,0)");
        ctx.save();
        ctx.translate(c, py);
        ctx.scale(1, 0.2);
        ctx.translate(-c, -py);
        ctx.fillStyle = pool;
        ctx.beginPath();
        ctx.arc(c, py, R * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 走査する弧（外側を逆向きに回る）
      const arcs: [number, number, number, number][] = mini
        ? [[1.32, 0.9, 1.4, 1.2]]
        : [[1.32, 0.5, 1.1, 1.6], [1.55, -0.3, 0.7, 2.6], [1.78, 0.18, 1.6, 1]];
      for (const [k, speed, len, w] of arcs) {
        const a0 = t * speed * (1 + energy * 1.5);
        for (let s = 0; s < 2; s++) {
          ctx.beginPath();
          ctx.arc(c, cy, R * k, a0 + s * Math.PI, a0 + s * Math.PI + len);
          ctx.strokeStyle = `rgba(${CYAN}, ${0.35 + 0.3 * b})`;
          ctx.lineWidth = w;
          ctx.stroke();
        }
      }

      // 軌道リング（傾いた楕円＋走る光点）
      const orbits: [number, number, number][] = mini ? [[1.2, 0.45, 0.7]] : [[1.25, 0.32, 0.6], [1.48, -0.5, -0.4]];
      for (const [k, rot, sp] of orbits) {
        ctx.save();
        ctx.translate(c, cy);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, R * k, R * k * 0.28, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${CYAN}, ${0.22 + 0.15 * b})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        const a = t * sp * (1 + energy);
        const x = Math.cos(a) * R * k;
        const y = Math.sin(a) * R * k * 0.28;
        const dot = ctx.createRadialGradient(x, y, 0, x, y, 7);
        dot.addColorStop(0, "rgba(255,255,255,0.95)");
        dot.addColorStop(1, `rgba(${CYAN}, 0)`);
        ctx.fillStyle = dot;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 経線・緯線
      ctx.lineWidth = 0.8;
      for (let m = 0; m < 6; m++) {
        const lon = (m / 6) * Math.PI;
        ctx.beginPath();
        for (let s = 0; s <= 48; s++) {
          const la = (s / 48) * Math.PI * 2;
          const p = project({ x: Math.cos(la) * Math.cos(lon), y: Math.sin(la), z: Math.cos(la) * Math.sin(lon) }, spin);
          if (s === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = `rgba(${CYAN}, ${0.1 + 0.06 * b})`;
        ctx.stroke();
      }
      for (const lat of [-0.6, -0.3, 0, 0.3, 0.6]) {
        const r = Math.cos(Math.asin(lat));
        const p = project({ x: 0, y: lat, z: 0 }, 0);
        ctx.beginPath();
        ctx.ellipse(c, p.y, R * r, R * r * Math.sin(tilt), 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${CYAN}, ${lat === 0 ? 0.28 : 0.1})`;
        ctx.stroke();
      }

      // 点の球
      for (const p0 of sphere) {
        const p = project(p0, spin);
        const front = (p.z + 1) / 2;
        const alpha = 0.12 + front * 0.75 * (0.75 + 0.25 * b);
        const s = (mini ? 0.7 : 0.6) + front * (mini ? 0.8 : 1.3);
        ctx.fillStyle = front > 0.82 ? `rgba(220, 245, 255, ${alpha})` : `rgba(${CYAN}, ${alpha})`;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }

      // 中心の光（呼吸で大きさ・明るさが変わる）
      const coreR = R * (0.34 + 0.12 * b + energy * 0.1);
      const core = ctx.createRadialGradient(c, cy, 0, c, cy, coreR);
      core.addColorStop(0, "rgba(255,255,255,1)");
      core.addColorStop(0.18, `rgba(200, 240, 255, ${0.85})`);
      core.addColorStop(0.45, `rgba(${CYAN}, ${0.35 + 0.2 * b})`);
      core.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(c, cy, coreR, 0, Math.PI * 2);
      ctx.fill();
      // 光の十字
      if (!mini) {
        const fl = R * (1.1 + 0.3 * b);
        const hz = ctx.createLinearGradient(c - fl, 0, c + fl, 0);
        hz.addColorStop(0, "rgba(0,0,0,0)");
        hz.addColorStop(0.5, `rgba(220,245,255,${0.45 + 0.25 * b})`);
        hz.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = hz;
        ctx.fillRect(c - fl, cy - 0.6, fl * 2, 1.2);
      }

      // 立ちのぼる粒
      for (const q of particles) {
        q.life += dt * q.speed * (1 + energy);
        if (q.life > 1) {
          q.life = 0;
          q.a = Math.random() * Math.PI * 2;
          q.r = Math.random();
        }
        const rx = R * 1.3 * q.r;
        const x = c + Math.cos(q.a) * rx;
        const y = cy + R * 1.42 + Math.sin(q.a) * rx * 0.17 - q.life * R * 2.2;
        const al = Math.sin(q.life * Math.PI) * 0.7;
        ctx.fillStyle = `rgba(${CYAN}, ${al})`;
        ctx.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
      }
      ctx.globalCompositeOperation = "source-over";
    };

    if (reducedMotion()) {
      draw(0, 0.6, 0);
      return;
    }
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [size, detail]);

  return <canvas ref={canvas} aria-hidden="true" className={className} style={{ width: size, height: size, display: "block" }} />;
}
