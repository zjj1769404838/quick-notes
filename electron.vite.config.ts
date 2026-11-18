import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // node-llama-cpp 与其预编译二进制必须保持 external，不打进 bundle
        external: ['node-llama-cpp', 'electron'],
        output: {
          // Electron 主进程需 CJS：electron 是 CJS 模块，ESM 具名导入会报
          // "does not provide an export named 'BrowserWindow'"
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      // 桌面应用没有 HTTP gzip，未压缩的注释/缩进会直接进内存与解析路径
      minify: 'esbuild',
      cssMinify: true,
      rollupOptions: {
        input: {
          ball: resolve(__dirname, 'src/renderer/ball.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html'),
          panel: resolve(__dirname, 'src/renderer/panel.html')
        },
        output: {
          // 把重依赖拆到独立 chunk：首屏只加载必需部分，且这些库几乎不变、利于缓存
          manualChunks: (id: string): string | undefined => {
            if (id.includes('node_modules')) {
              if (id.includes('@codemirror') || id.includes('@lezer') || id.includes('/codemirror/')) {
                return 'vendor-codemirror'
              }
              if (id.includes('markdown-it') || id.includes('dompurify') || id.includes('linkify-it')) {
                return 'vendor-markdown'
              }
              return 'vendor'
            }
            return undefined
          }
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
