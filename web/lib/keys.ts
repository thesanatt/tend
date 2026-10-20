// sessionStorage keys. Everything Tend stores lives in the current tab only.
export const SESSION_KEY = "tend.session.v1";
// Set by Exit this page so a page restored from the browser's back cache reloads blank.
export const LEFT_KEY = "tend.left";
// Set while a visitor takes the 2-minute tour (components/tour). Exit this page clears it with the rest.
export const TOUR_KEY = "tend.tour";
// For the privacy line after a reload: two flags, that this tab sent something and that a state was
// picked, nothing else (components/flow/keptSends.ts). Any load that is not a reload drops them, and
// Exit this page clears them with the rest.
export const SENT_KEY = "tend.sent.v1";
