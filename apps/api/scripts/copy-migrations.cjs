const { cpSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const apiRoot = join(__dirname, "..");
const source = join(apiRoot, "..", "..", "packages", "db", "drizzle");
const destination = join(apiRoot, "dist", "drizzle");

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
