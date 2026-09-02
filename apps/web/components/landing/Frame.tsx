/**
 * The viewport frame: a fixed ink border around the window, the reference's
 * `.hw-frame`. It is the margin the paper panel sits inside, and it is what
 * makes the panel read as a sheet placed on the water rather than a section
 * that happens to be white. Pointer-events off, hidden on phones where the
 * width it would take is the width the copy needs.
 */
export function Frame() {
  return <div className="frame" aria-hidden="true" />;
}
