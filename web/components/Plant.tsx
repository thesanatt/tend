"use client";

import { useEffect, useRef, useState } from "react";
import { leafPath, plantShape, VIEW, type Stage } from "@/lib/garden";
import styles from "./Plant.module.css";

interface PlantProps {
  stage: Stage;
  growth?: number;
  seedKey: string;
  className?: string;
  // Without a label the drawing is decorative and hidden from screen readers.
  label?: string;
  // Off where the page draws its own soil line.
  ground?: boolean;
}

const ORDER: Stage[] = ["seed", "sprout", "leaf", "bud", "bloom"];
const { w, h, ground, cx } = VIEW;

export default function Plant({
  stage,
  growth = 0.5,
  seedKey,
  className,
  label,
  ground: showGround = true,
}: PlantProps) {
  const shape = plantShape(stage, growth, seedKey);
  const prev = useRef(stage);
  const [growing, setGrowing] = useState(false);

  // Motion only on a real stage change, never on first paint.
  useEffect(() => {
    if (prev.current === stage) return;
    const grew = ORDER.indexOf(stage) > ORDER.indexOf(prev.current);
    prev.current = stage;
    if (!grew) return;
    setGrowing(true);
    const t = window.setTimeout(() => setGrowing(false), 900);
    return () => window.clearTimeout(t);
  }, [stage]);

  const { top } = shape;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={`${styles.plant} ${growing ? styles.growing : ""} ${className ?? ""}`}
      data-stage={stage}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {showGround || stage === "seed" ? (
        <path
          d={`M${cx - 11} ${ground + 0.5}H${cx + 11}`}
          className={stage === "seed" ? styles.groundOpen : styles.ground}
        />
      ) : null}
      {stage === "seed" ? (
        <ellipse
          cx={cx}
          cy={ground - 2.6}
          rx="3"
          ry="2"
          transform={`rotate(-18 ${cx} ${ground - 2.6})`}
          className={styles.seed}
        />
      ) : null}
      {shape.stem ? <path d={shape.stem} className={styles.stem} /> : null}
      <g className={styles.foliage} style={{ transformOrigin: `${cx}px ${ground}px` }}>
        {shape.leaves.map((leaf, i) => (
          <g key={i} transform={`translate(${leaf.x} ${leaf.y}) scale(${leaf.side} 1) rotate(${leaf.angle})`}>
            <path d={leafPath(leaf.length)} className={styles.leaf} />
            <path
              d={`M0.6 0Q${leaf.length * 0.5} ${-leaf.length * 0.06} ${leaf.length * 0.88} 0`}
              className={styles.rib}
            />
          </g>
        ))}
        {shape.cotyledons ? (
          <>
            <path d={`M${top.x} ${top.y}c-3-0.5-7.2-2.8-7.6-6.6c3.8-0.6 7.2 2 7.6 6.6z`} className={styles.leaf} />
            <path d={`M${top.x} ${top.y}c3-0.5 7.2-2.8 7.6-6.6c-3.8-0.6-7.2 2-7.6 6.6z`} className={styles.leaf} />
          </>
        ) : null}
        {shape.bud ? (
          <>
            <path d={`M${top.x} ${top.y + 1}c-4-1.8-4.4-8.6 0-12.6c4.4 4 4 10.8 0 12.6z`} className={styles.bud} />
            <path
              d={`M${top.x} ${top.y + 1.2}c-2.6-0.2-4.6-1.8-5-4.2M${top.x} ${top.y + 1.2}c2.6-0.2 4.6-1.8 5-4.2`}
              className={styles.sepal}
            />
          </>
        ) : null}
        {shape.petals ? (
          <g transform={`translate(${top.x} ${top.y - 5.4})`}>
            {Array.from({ length: shape.petals }, (_, i) => (
              <ellipse
                key={i}
                cx="0"
                cy="-5.3"
                rx="3.2"
                ry="4.8"
                transform={`rotate(${(360 / shape.petals) * i + 12})`}
                className={styles.petal}
              />
            ))}
            <circle r="2.7" className={styles.heart} />
          </g>
        ) : null}
      </g>
    </svg>
  );
}
