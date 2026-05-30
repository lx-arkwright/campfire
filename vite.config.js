import { defineConfig } from "vite";

// The client lives in client/, builds to client/dist/, which the Node server
// serves in production. In dev, Vite runs on 5173 and the socket connects
// straight to the Node server on 3000 (see client/src/main.js).
export default defineConfig({
  root: "client",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
