// Web panel: a right-Sidebar tab that shows a private display live.
//
// Why a Sidebar tab and not a composer decoration: a live frame is viewport, not
// input furniture. It has its own chrome and its own lifetime, it should survive
// you leaving the composer, and it must not push the conversation around. The
// right Sidebar gives it a tab, a close affordance, and room to breathe.
//
// The panel polls one PNG from /virtual-display/frame and posts events back to
// /virtual-display/input. Polling (not SSE) because a timer is trivially
// disposable and cannot leak a socket when the tab unmounts; at 1-3 fps the
// difference is invisible for a config-debugging panel.
window.__ModuleLoader__.load({
  id: 'dsh-virtual-display',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const BASE = '/virtual-display'
    const KIND = 'virtual-display'
    const TAB_ID = 'dsh-virtual-display'

    // Every visible string lives here; `zh` is the key-set source of truth and
    // `en` must stay key-identical. The factory cannot import a sibling module,
    // so the dictionaries are inline.
    const NS = 'virtualDisplay'
    const zh = {
      'tab.title': '虚拟显示器',
      'tab.description': '实时查看一块私有虚拟显示器，并直接点进去操作。',
      'empty.title': '还没有运行中的虚拟显示器。',
      'empty.hint': '让 Agent 用 virtual_display 工具执行 action: "start"，然后重新打开此标签页。',
      'picker.aria': '虚拟显示器会话',
      'session.option': '{backend} {display} — {id}',
      'frame.waiting': '正在等待画面…',
      'frame.paused': '已暂停。',
      'frame.alt': '私有虚拟显示器画面',
      'frame.hint': '点击画面即可在该位置发送一次点击。',
      'action.enter': '回车',
      'action.scroll': '滚动',
      'action.refresh': '刷新',
      'action.pause': '暂停',
      'action.resume': '继续',
      'action.slow': '慢速',
      'action.fast': '快速',
      'audio.sink': '音频 → {sink}',
      'error.frame': '无法获取画面：{message}',
      'error.list': '无法获取会话列表：{message}',
      'error.rejected': '操作被拒绝：{message}',
    }
    const en = {
      'tab.title': 'Virtual display',
      'tab.description': 'Watch a private virtual display live and click into it.',
      'empty.title': 'No live virtual display yet.',
      'empty.hint': 'Ask the agent to run the virtual_display tool with action: "start", then reopen this tab.',
      'picker.aria': 'Virtual display session',
      'session.option': '{backend} {display} — {id}',
      'frame.waiting': 'Waiting for a frame…',
      'frame.paused': 'Paused.',
      'frame.alt': 'Private virtual display',
      'frame.hint': 'Click the frame to send a click at that point.',
      'action.enter': 'Enter',
      'action.scroll': 'Scroll',
      'action.refresh': 'Refresh',
      'action.pause': 'Pause',
      'action.resume': 'Resume',
      'action.slow': 'Slow',
      'action.fast': 'Fast',
      'audio.sink': 'audio → {sink}',
      'error.frame': 'Could not fetch frame: {message}',
      'error.list': 'Could not fetch session list: {message}',
      'error.rejected': 'Rejected: {message}',
    }

    /** Fallback when a slot cannot inject `t` (older host, or a bare render). */
    function fallbackTranslate(namespace) {
      return (key, params) => {
        const dict = namespace === NS ? en : {}
        const template = dict[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (whole, name) =>
          params[name] === undefined ? whole : String(params[name]),
        )
      }
    }

    async function getJson(path) {
      const response = await fetch(path, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`${path} answered ${response.status}`)
      return response.json()
    }

    /** Poll the live session list while the tab is visible. */
    function useSessions(visible) {
      const [sessions, setSessions] = useState([])
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!visible) return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const data = await getJson(`${BASE}/sessions`)
            if (cancelled) return
            setSessions(data.sessions ?? [])
            setError(null)
          } catch (cause) {
            if (!cancelled) setError(cause.message)
          }
        }
        void tick()
        const timer = setInterval(tick, 3000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [visible])

      return { sessions, error }
    }

    /**
     * Poll one session's frame.
     *
     * `nonce` forces a refetch after an injection so the picture updates at once
     * instead of waiting for the next tick.
     */
    function useFrame(sessionId, visible, nonce, intervalMs) {
      const [src, setSrc] = useState(null)
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!visible || sessionId === undefined || sessionId === '') {
          setSrc(null)
          return undefined
        }
        let cancelled = false
        let objectUrl
        const tick = async () => {
          try {
            const response = await fetch(
              `${BASE}/frame?sessionId=${encodeURIComponent(sessionId)}&t=${Date.now()}`,
              { credentials: 'same-origin', cache: 'no-store' },
            )
            if (!response.ok) throw new Error(`frame answered ${response.status}`)
            const blob = await response.blob()
            if (cancelled) return
            const next = URL.createObjectURL(blob)
            setSrc((previous) => {
              if (previous !== null) URL.revokeObjectURL(previous)
              return next
            })
            objectUrl = next
            setError(null)
          } catch (cause) {
            if (!cancelled) setError(cause.message)
          }
        }
        void tick()
        const timer = setInterval(tick, intervalMs)
        return () => {
          cancelled = true
          clearInterval(timer)
          if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
        }
      }, [sessionId, visible, nonce, intervalMs])

      return { src, error }
    }

    // Inherit the host theme: only --dsw-alias-* tokens and inherited colours.
    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
        fontSize: '12px',
        color: 'var(--dsw-alias-text-secondary, #8a8f98)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      select: {
        flex: '1 1 auto',
        minWidth: '0',
        padding: '4px 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #3a3f46)',
        background: 'var(--dsw-alias-surface, transparent)',
        color: 'inherit',
        fontSize: '12px',
      },
      button: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #3a3f46)',
        background: 'var(--dsw-alias-surface, transparent)',
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      stage: {
        position: 'relative',
        lineHeight: 0,
        borderRadius: '6px',
        overflow: 'hidden',
        border: '1px solid var(--dsw-alias-border, #3a3f46)',
        background: '#111',
        // The frame is the point of the tab, so it takes the available height.
        flex: '1 1 auto',
        minHeight: '120px',
        display: 'flex',
        alignItems: 'center',
      },
      image: { width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' },
      hint: { fontSize: '11px', opacity: 0.7 },
      error: {
        color: 'var(--dsw-alias-danger, #e5484d)',
        fontSize: '11px',
        wordBreak: 'break-word',
      },
      empty: { fontSize: '12px', opacity: 0.7, lineHeight: 1.5 },
    }

    /**
     * The tab body.
     *
     * `useTabInfo` is supplied by the Sidebar framework and carries the tab's
     * navigation params, so opening the tab with `{ sessionId }` selects that
     * display immediately.
     */
    function VirtualDisplayTab(props) {
      // `t` is injected by the slot because the registration declares `locale`.
      const t = props.t ?? fallbackTranslate(NS)
      const tab = props.useTabInfo?.()
      const requested = tab?.tab?.navigation?.params?.virtualDisplay?.sessionId

      const [selected, setSelected] = useState(requested ?? '')
      const [nonce, setNonce] = useState(0)
      const [note, setNote] = useState(null)
      const [intervalMs, setIntervalMs] = useState(1000)
      const [paused, setPaused] = useState(false)
      const imageRef = useRef(null)

      const { sessions, error: listError } = useSessions(!paused)
      const { src, error: frameError } = useFrame(selected, !paused, nonce, intervalMs)

      // Follow the requested session when the tab is re-pointed.
      useEffect(() => {
        if (requested !== undefined && requested !== selected) setSelected(requested)
      }, [requested])

      // Keep the selection valid as sessions come and go.
      useEffect(() => {
        if (sessions.length === 0) return
        if (!sessions.some((s) => s.sessionId === selected)) {
          setSelected(sessions[0].sessionId)
        }
      }, [sessions, selected])

      const inject = useCallback(
        async (payload) => {
          if (selected === '') return
          try {
            const response = await fetch(
              `${BASE}/input?sessionId=${encodeURIComponent(selected)}`,
              {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              },
            )
            const data = await response.json()
            if (!response.ok || data.ok !== true) {
              setNote(data.error ?? `rejected (${response.status})`)
              return
            }
            setNote(null)
            setNonce((n) => n + 1)
          } catch (cause) {
            setNote(cause.message)
          }
        },
        [selected],
      )

      /**
       * Translate a click on the frame into display pixels.
       *
       * The image is laid out at whatever width the Sidebar has, so the offset
       * must be rescaled by naturalWidth/clientWidth or every click lands short.
       */
      const onClick = useCallback(
        (event) => {
          const image = imageRef.current
          if (image === null || image.naturalWidth === 0) return
          const rect = image.getBoundingClientRect()
          const x = Math.round((event.clientX - rect.left) * (image.naturalWidth / rect.width))
          const y = Math.round((event.clientY - rect.top) * (image.naturalHeight / rect.height))
          void inject({ kind: 'click', x, y })
        },
        [inject],
      )

      const target = sessions.find((s) => s.sessionId === selected)

      if (sessions.length === 0 && listError === null) {
        return h(
          'div',
          { style: styles.root },
          h(
            'div',
            { style: styles.empty },
            t('empty.title'),
            h('br'),
            t('empty.hint'),
          ),
        )
      }

      const picker = h(
        'select',
        {
          style: styles.select,
          value: selected,
          onChange: (event) => setSelected(event.target.value),
          'aria-label': t('picker.aria'),
        },
        sessions.map((s) =>
          h(
            'option',
            { key: s.sessionId, value: s.sessionId },
            t('session.option', {
              backend: s.backend ?? s.platform ?? '',
              display: s.display !== undefined ? `:${s.display}` : '',
              id: s.sessionId.slice(0, 8),
            }),
          ),
        ),
      )

      const frame =
        src === null
          ? h('div', { style: styles.empty }, paused ? t('frame.paused') : t('frame.waiting'))
          : h(
              'div',
              { style: styles.stage },
              h('img', {
                ref: imageRef,
                src,
                alt: t('frame.alt'),
                style: styles.image,
                onClick,
              }),
            )

      return h(
        'div',
        { style: styles.root },
        h('div', { style: styles.row }, picker),
        frame,
        h(
          'div',
          { style: styles.row },
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => void inject({ kind: 'key', key: 'Return' }), disabled: selected === '' },
            t('action.enter'),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => void inject({ kind: 'scroll', direction: 'down', amount: 3 }), disabled: selected === '' },
            t('action.scroll'),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => setNonce((n) => n + 1) },
            t('action.refresh'),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => setPaused((v) => !v) },
            paused ? t('action.resume') : t('action.pause'),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => setIntervalMs((ms) => (ms === 1000 ? 3000 : 1000)) },
            intervalMs === 1000 ? t('action.slow') : t('action.fast'),
          ),
        ),
        h('div', { style: styles.hint }, t('frame.hint')),
        target?.audio?.isolated === true
          ? h('div', { style: styles.hint }, t('audio.sink', { sink: target.audio.sink }))
          : null,
        target?.warning !== undefined ? h('div', { style: styles.hint }, target.warning) : null,
        listError !== null ? h('div', { style: styles.error }, listError) : null,
        frameError !== null ? h('div', { style: styles.error }, frameError) : null,
        note !== null ? h('div', { style: styles.error }, note) : null,
      )
    }

    /** The tab chip's title; falls back to the registry's captured text. */
    function VirtualDisplayTitle(props) {
      const t = props?.t ?? fallbackTranslate(NS)
      return t('tab.title')
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        // Register the dictionaries first: everything below translates through
        // this namespace, and the Sidebar reads tab titles lazily but the guide
        // and chip can be read immediately.
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'virtual-display: dictionaries')
        const t = ctx.locale.bind(NS)

        // The tab type: what "virtual display" means as a page kind.
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: KIND,
              // One display at a time; a second tab of this kind is the same page.
              multiple: false,
              // A live preview is only worth anything while it is on screen.
              keepMounted: false,
              priority: 'extension',
              title: () => t('tab.title'),
              guide: [
                {
                  id: TAB_ID,
                  order: 60,
                  title: () => t('tab.title'),
                  description: () => t('tab.description'),
                },
              ],
            }),
          'virtual-display: sidebar tab type',
        )

        // The body and chip, dispatched by kind. `locale: NS` is what makes the
        // framework inject `t` into each component.
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS },
            VirtualDisplayTab,
          ),
        )
        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS },
            VirtualDisplayTitle,
          ),
        )
      },
    }
  },
})
