// Cross-platform replacement for `rm -rf dist` (cmd.exe has no `rm`).
const fs = require("fs");
const path = require("path");
fs.rmSync(path.join(__dirname, "..", "dist"), { recursive: true, force: true });
