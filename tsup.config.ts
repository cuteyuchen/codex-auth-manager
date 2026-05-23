import {defineConfig} from "tsup";

export default defineConfig({
  entry: {
    server: "src/backend/server.ts",
  },
  outDir: "bundle",
  format: ["cjs"],
  target: "node20",
  platform: "node",
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  noExternal: [
    "fetch-cookie",
    "tough-cookie",
    "undici",
    "socks",
  ],
  external: [
    "playwright-core",
    "chromium-bidi",
  ],
  outExtension() {
    return {
      js: ".cjs",
    };
  },
});
