/**
 * The entry point of the Claude Desktop bundle (mcpb/manifest.json): it always starts the server. `src/index.ts` starts itself only
 * when it is the program (`require.main === module`), which is false when a launcher loads it with require(); the server would then
 * stay silent and the client's first request would time out. A launcher that loads this file gets a server either way.
 */
import { run } from "./index";

run();
