// What an open preview holds outside React: a pdf.js document, an object URL for a photo. Each is
// released when its preview closes, and all at once by Exit this page, so nothing readable lingers.
const held = new Set<() => void>();

// Registers a release; the returned function releases it once (closing the preview).
export function hold(release: () => void): () => void {
  held.add(release);
  return () => {
    if (held.delete(release)) release();
  };
}

export function releasePreviews(): void {
  for (const release of [...held]) {
    held.delete(release);
    try {
      release();
    } catch {
      // One failed release never stops the others, or the exit.
    }
  }
}

export function heldCount(): number {
  return held.size;
}
