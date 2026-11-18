import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ClassifierEval from "@/components/dev/ClassifierEval";

export const metadata: Metadata = {
  title: "Classifier check",
  description: "A development page. It is not part of the built site.",
  robots: { index: false, follow: false },
};

// Development only: records the built-in model's answers for the held-out rows (docs/EVAL.md, "Sorting
// costs"). The built site answers this address with its not-found page, and the sitemap never lists it.
export default function ClassifierEvalPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="page">
      <ClassifierEval />
    </div>
  );
}
