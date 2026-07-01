/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_YT_HLS_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
