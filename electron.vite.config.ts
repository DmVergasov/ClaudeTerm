import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    resolve: {
      // @xterm/headless 6.0.0 names a "module" entry its tarball does not ship; the bundler takes the "main" file it does ship
      alias: { '@xterm/headless': resolve(__dirname, 'node_modules/@xterm/headless/lib-headless/xterm-headless.js') }
    }
  },
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        // the terminal window and the settings window
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
