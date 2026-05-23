import {defineConfig} from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const apiPort = process.env.CODEX_REGISTER_WEB_PORT ?? "3789";

export default defineConfig({
    root: path.resolve(__dirname),
    plugins: [vue(), tailwindcss()],
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
    server: {
        host: "127.0.0.1",
        port: 5173,
        proxy: {
            "/api": `http://127.0.0.1:${apiPort}`,
        },
    },
});
