/** 全局 Window 类型声明：preload 暴露的 API */
import type { QnApi } from '../../preload/index.js'

declare global {
  interface Window {
    qn: QnApi
  }
}

export {}
