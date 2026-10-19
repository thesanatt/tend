// Where visitors go to read more. Shared by the home page, How it works, and the tour summary.
const REPO = "https://github.com/thesanatt/tend";

export const LINKS = {
  repo: REPO,
  devpost: "https://devpost.com/software/tend-ua9rm8",
  // The last commit before the MHacks submission deadline (Oct 4, 2026, 11:02 AM ET).
  judged: `${REPO}/tree/5d1f7bd`,
  judges: `${REPO}/blob/main/docs/JUDGES.md`,
  eval: `${REPO}/blob/main/docs/EVAL.md`,
  privacy: `${REPO}/blob/main/docs/PRIVACY.md`,
  figma: "https://www.figma.com/design/kPZUqX0ptO138LzG1ah9hk",
} as const;
