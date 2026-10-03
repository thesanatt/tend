"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import styles from "./StateFinder.module.css";

// Pick a state and open its page. Choosing does not navigate by itself; the button does.
export default function StateFinder({ states }: { states: { st: string; name: string }[] }) {
  const router = useRouter();
  const id = useId();
  const [st, setSt] = useState("");
  const [error, setError] = useState(false);

  function open(e: FormEvent) {
    e.preventDefault();
    if (!st) {
      setError(true);
      return;
    }
    router.push(`/${st.toLowerCase()}`);
  }

  return (
    <form className={styles.finder} onSubmit={open}>
      <label htmlFor={id} className={styles.label}>
        Find your state
      </label>
      <div className={styles.row}>
        <select
          id={id}
          value={st}
          onChange={(e) => {
            setSt(e.target.value);
            setError(false);
          }}
          aria-invalid={error || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        >
          <option value="">Choose a state</option>
          {states.map((s) => (
            <option key={s.st} value={s.st}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary">
          See what it promises
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className={styles.error} role="alert">
          Choose a state first.
        </p>
      ) : null}
    </form>
  );
}
