/// <reference types="vite/client" />

// Injected at build time by vite.config.ts via `define`. Read from
// the package.json version of the plugin so the webapp can render
// it without a settings/health roundtrip.
declare const __PLUGIN_VERSION__: string
