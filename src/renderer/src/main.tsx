import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './components/richtext/richtext.css'
import './pages/paperdetail.css'
import './components/chat/chat.css'
import './components/export/export.css' // M6 lane/ui（预备提交：空文件占位）
import './components/settings/pdfsrc.css' // M6 lane/ui（预备提交：空文件占位）

// D200：smoke / agent e2e 由主进程带 ?motion=off；首帧前关闭全部动效，保证确定性。
if (new URLSearchParams(window.location.search).get('motion') === 'off') {
  document.documentElement.dataset.motion = 'off'
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
