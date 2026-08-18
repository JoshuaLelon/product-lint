import { render } from "ink";
import { loadConfig } from "../src/config.js";
import { App } from "./app.js";
import { ROOT, readGraph } from "./graph.js";
import { clearOnResize } from "./terminal.js";

// `bun main.tsx vocabulary-index` opens on the first node whose id contains that.
const startAt = process.argv[2];

const config = await loadConfig(ROOT);

// Before render, so this listener sits ahead of Ink's own resize handler.
clearOnResize(process.stdout);

render(<App config={config} initial={await readGraph(config)} startAt={startAt} />, {
  // The app owns the screen, the way vim and htop do. Without it Ink erases the
  // previous frame by counting back over it, so resizing the terminal — which
  // reflows what was already written — leaves fragments of older, narrower
  // frames stranded above the app with nothing able to clear them. On the
  // alternate screen a resize is just a repaint, and quitting restores whatever
  // was in the terminal before.
  alternateScreen: true,
});
