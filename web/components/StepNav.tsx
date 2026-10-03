"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./StepNav.module.css";

const STEPS = [
  { href: "/ledger", label: "Costs" },
  { href: "/bill", label: "Bill" },
  { href: "/claim", label: "Claim" },
  { href: "/garden", label: "Garden" },
];

// Steps replace history instead of pushing it, so Back leaves Tend rather than walking through costs.
export default function StepNav() {
  const path = usePathname();
  return (
    <nav aria-label="Your claim" className={`${styles.steps} no-print`}>
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.href}>
            <Link replace href={s.href} aria-current={path === s.href ? "step" : undefined}>
              <span className={styles.n} aria-hidden="true">
                {i + 1}
              </span>
              {s.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
