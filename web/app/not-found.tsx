import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page" style={{ display: "grid", gap: "var(--space-5)", paddingBlock: "var(--space-8)" }}>
      <h1>This page is not here</h1>
      <p className="lead">The link may be old or mistyped.</p>
      <p>
        <Link href="/">Go to the law garden</Link>
      </p>
    </div>
  );
}
