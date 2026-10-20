// What only Sanat can write or choose for the press kit. Kept apart from facts.ts, which reads the file
// system, so the site's footer can also tell whether a contact address is set. Each stays null until he
// fills it in; until then /press leaves its section out and the fact sheet leaves its line out.

// TODO(Sanat): two or three sentences, in your own words, on why you built Tend.
export const WHY: string | null = null;

// TODO(Sanat): the address reporters should write to. Until it is set, the footer does not link /press.
export const CONTACT: string | null = null;

// TODO(Sanat): the demo video's unlisted YouTube link, once it is recorded. It stays a link: the site's
// security policy allows no frames, so an embed would not load.
export const VIDEO: string | null = null;
