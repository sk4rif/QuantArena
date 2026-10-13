/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional JSON override for arena origins; see `games/snake/servers.ts`. */
  readonly VITE_SNAKE_ORIGINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
