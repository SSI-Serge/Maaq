"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import styles from "./auth.module.css";

const DOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** Distance (px) à laquelle le doigt « accroche » un point. */
const HIT_RADIUS = 26;
// Mise en page de la grille (voir auth.module.css) : cases de 56 px, espacées de 14 px, marge de 18 px.
const CELL = 56;
const GAP = 14;
const PAD = 18;
const BORDER = 1;

/** Centre d'un point, dans le repère intérieur de la grille. */
function center(i: number): { x: number; y: number } {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return { x: PAD + col * (CELL + GAP) + CELL / 2, y: PAD + row * (CELL + GAP) + CELL / 2 };
}

export interface PatternGridProps {
  value: number[];
  onChange: (points: number[]) => void;
  disabled?: boolean;
  /** Tracé en rouge après un échec (US-6, maquette Connexion). */
  error?: boolean;
}

/**
 * Grille de schéma tactile 3 × 3 (US-6 RF2). On trace en glissant le doigt d'un point à l'autre,
 * ou on touche les points un par un (comme dans la maquette). Chaque point est aussi un bouton,
 * utilisable au clavier.
 */
export function PatternGrid({ value, onChange, disabled = false, error = false }: PatternGridProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ start: number[]; points: number[] } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [drawing, setDrawing] = useState<number[] | null>(null);

  const shown = drawing ?? value;

  function hit(event: ReactPointerEvent): { dot: number | null; x: number; y: number } {
    const box = boxRef.current!.getBoundingClientRect();
    const x = event.clientX - box.left - BORDER;
    const y = event.clientY - box.top - BORDER;
    const dot = DOTS.find((i) => Math.hypot(center(i).x - x, center(i).y - y) <= HIT_RADIUS);
    return { dot: dot ?? null, x, y };
  }

  /** Un geste qui relie plusieurs points remplace le tracé ; un simple toucher ajoute un point. */
  function displayed(start: number[], points: number[]): number[] {
    if (points.length >= 2) return points;
    return points.length === 1 && !start.includes(points[0]) ? [...start, points[0]] : start;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const { dot, x, y } = hit(event);
    if (dot === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { start: value, points: [dot] };
    setDrawing(displayed(value, [dot]));
    setCursor({ x, y });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current) return;
    // Une souris qui survole sans bouton enfoncé ne trace rien.
    if (event.pointerType === "mouse" && event.buttons === 0) return;
    const { dot, x, y } = hit(event);
    if (dot !== null && !current.points.includes(dot)) {
      current.points = [...current.points, dot];
      setDrawing(displayed(current.start, current.points));
    }
    setCursor({ x, y });
  }

  function onPointerUp() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setCursor(null);
    setDrawing(null);
    onChange(displayed(current.start, current.points));
  }

  const line = shown.map((i) => `${center(i).x},${center(i).y}`).join(" ");
  const last = shown.length ? center(shown[shown.length - 1]) : null;

  return (
    <div
      ref={boxRef}
      className={`${styles.patternBox} ${disabled ? styles.patternDisabled : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="group"
      aria-label="Grille du schéma tactile"
    >
      <svg className={styles.patternLines} aria-hidden>
        {shown.length > 1 && <polyline points={line} className={error ? styles.lineError : styles.line} />}
        {cursor && last && <line x1={last.x} y1={last.y} x2={cursor.x} y2={cursor.y} className={styles.line} />}
      </svg>
      {DOTS.map((i) => {
        const order = shown.indexOf(i);
        return (
          <button
            key={i}
            type="button"
            disabled={disabled}
            className={`${styles.dot} ${order >= 0 ? (error ? styles.dotError : styles.dotOn) : ""}`}
            aria-label={`Point ${i + 1}${order >= 0 ? `, relié en position ${order + 1}` : ""}`}
            aria-pressed={order >= 0}
            onClick={(event) => {
              // Clavier uniquement : le toucher et la souris passent par les gestes ci-dessus.
              if (event.detail === 0 && order < 0) onChange([...value, i]);
            }}
          />
        );
      })}
    </div>
  );
}
