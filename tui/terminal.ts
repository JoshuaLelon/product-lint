/**
 * Erase the screen before Ink repaints a resized frame.
 *
 * Ink clears on its own when the terminal NARROWS — its resize handler reads
 * `currentWidth < lastTerminalWidth` and wipes the screen "to prevent duplicate
 * overlapping re-renders" — but it does nothing on the way back out. Widening is
 * the same hazard in reverse: lines that were wrapped at the old width unwrap at
 * the new one, so the count Ink erases by no longer matches the rows the old
 * frame actually occupies, and part of it survives under the new frame. That is
 * the doubled title: a narrow frame stranded beneath a wide one.
 *
 * `prependListener` is the whole trick. Ink registers its own resize handler
 * when it mounts, and that handler is what re-renders; a listener added
 * afterwards would run second and erase the frame Ink had just drawn. Going
 * first means the screen is blank when Ink paints.
 *
 * Not fixable from inside the component: the reset Ink does on the narrow path
 * clears `lastOutput` and `lastOutputToRender`, which are private, and the
 * public `clear()` deliberately syncs them so the next render is skipped as
 * unchanged — the opposite of what a resize needs.
 */
/**
 * Erase the visible screen and home the cursor — deliberately without the
 * scrollback-erasing variant. On the alternate screen there is no scrollback to
 * erase, so it would buy nothing; anywhere else it would destroy the terminal
 * history of whoever ran this, which is not a resize's business.
 */
const ERASE_SCREEN = "[2J[H";

export function clearOnResize(stdout: NodeJS.WriteStream): () => void {
  const erase = () => {
    // A non-TTY has no screen to erase and no resize to answer; writing control
    // codes into a pipe or a file would only corrupt whatever reads it.
    if (!stdout.isTTY) return;
    stdout.write(ERASE_SCREEN);
  };
  stdout.prependListener("resize", erase);
  return () => {
    stdout.off("resize", erase);
  };
}

export { ERASE_SCREEN };
