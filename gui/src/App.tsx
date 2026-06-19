import { useEffect, useRef } from 'react'
import { Sidebar } from '@/components/Sidebar.js'
import { SessionPane } from '@/components/SessionPane.js'
import { EmptyState } from '@/components/EmptyState.js'
import { RightPane } from '@/components/RightPane.js'
import { useSessionStore } from '@/state/sessionStore.js'

export function App(): JSX.Element {
  const init = useSessionStore((s) => s.init)
  const bootstrapped = useSessionStore((s) => s.bootstrapped)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const history = useSessionStore((s) => s.history)
  const createDraftTab = useSessionStore((s) => s.createDraftTab)
  const autoDraftDoneRef = useRef(false)

  useEffect(() => {
    void init()
  }, [init])

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null

  // Composer 优先启动：如果历史记录中有工作区但没有打开的 tab，
  // 则打开一个指向最近工作区的草稿。我们等待历史记录加载后再做决定——
  // refreshHistory 是异步的，所以 `initialized` 在历史仍为空时就会变为 true。
  // 一旦历史记录被填充，我们就标记决策完成，这样之后关闭最后一个 tab 就不会重新创建草稿。
  useEffect(() => {
    if (autoDraftDoneRef.current) return
    if (!bootstrapped) return
    const firstWorkDir = history[0]?.workDir
    if (!firstWorkDir) return
    autoDraftDoneRef.current = true
    if (tabs.length > 0) return
    createDraftTab(firstWorkDir)
  }, [bootstrapped, tabs.length, history, createDraftTab])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey || event.key.toLowerCase() !== 'n') {
        return
      }
      const workDir = activeTab?.workDir ?? history[0]?.workDir
      if (!workDir) return
      event.preventDefault()
      createDraftTab(workDir)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab?.workDir, createDraftTab, history])

  return (
    <div className="flex h-full flex-col bg-pane">
      {/* macOS 标题栏的隐形拖拽区域——Electron 的 hiddenInset
          处理实际的 traffic lights；我们只需要拖拽区域。 */}
      <div className="titlebar-drag h-9 shrink-0" />

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab ? (
            <SessionPane key={activeTab.tabId} tab={activeTab} />
          ) : (
            <EmptyState />
          )}
        </main>
        {activeTab?.status === 'ready' && <RightPane key={activeTab.tabId} tab={activeTab} />}
      </div>
    </div>
  )
}
