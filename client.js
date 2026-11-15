// Web panel: live frames from a private display, plus click-to-inject.
//
// The panel is a decoration in the composer dock, not a full page: it belongs
// next to the conversation it is helping with. Frames are polled from
// /virtual-display/frame and clicks are posted to /virtual-display/input, so the
// panel needs no state of its own beyond which session it is watching.
//
// Deliberately polls rather than streams. An SSE channel would be smoother, but
// a timer is trivially disposable and cannot leak a socket when the slot
// unmounts — and at 2 fps the difference is invisible for a config-debugging
// panel.
window.__ModuleLoader__.load({
  id: 'dsh-virtual-display',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const BASE = '/virtual-display'

    async function getJson(path) {
      const response = await fetch(path, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`${path} answered ${response.status}`)
      return response.json()
    }

    /** Poll the live sessions list, so the picker reflects reality. */
    function useSessions(active) {
      const [sessions, setSessions] = useState([])
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!active) return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const data = await getJson(`${BASE}/sessions`)
            if (!cancelled) {
              setSessions(data.sessions ?? [])
              setError(null)
            }
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
      }, [active])

      return { sessions, error }
    }

    /**
     * Poll one session's frame.
     *
     * `nonce` forces a refetch after an injection, so the picture updates
     * immediately instead of waiting for the next interval.
     */
    function useFrame(sessionId, active, nonce, intervalMs) {
      const [src, setSrc] = useState(null)
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!active || sessionId === undefined) {
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
      }, [sessionId, active, nonce, intervalMs])

      return { src, error }
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 0 4px',
        width: '100%',
        fontSize: '12px',
        color: 'var(--dsw-alias-text-secondary, #8a8f98)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      select: {
        flex: '1 1 auto',
        minWidth: '0',
        padding: '3px 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #3a3f46)',
        background: 'var(--dsw-alias-surface, transparent)',
        color: 'inherit',
        fontSize: '12px',
      },
      button: {
        padding: '3px 10px',
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
      },
      image: { width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' },
      hint: { fontSize: '11px', opacity: 0.7 },
      error: { color: 'var(--dsw-alias-danger, #e5484d)', fontSize: '11px', wordBreak: 'break-word' },
      empty: { fontSize: '11px', opacity: 0.7, padding: '4px 0' },
    }

    function VirtualDisplayPanel(props) {
      // Render only where a session is in scope; the dock is ambient otherwise.
      const sessionId = props?.sessionId ?? props?.session?.id
      const [open, setOpen] = useState(false)
      const [selected, setSelected] = useState(sessionId ?? '')
      const [nonce, setNonce] = useState(0)
      const [note, setNote] = useState(null)
      const [intervalMs, setIntervalMs] = useState(1000)
      const imageRef = useRef(null)

      const { sessions, error: listError } = useSessions(open)
      const { src, error: frameError } = useFrame(
        selected === '' ? undefined : selected,
        open,
        nonce,
        intervalMs,
      )

      // Keep the selection valid as sessions come and go.
      useEffect(() => {
        if (!open) return
        if (sessions.length === 0) return
        const stillThere = sessions.some((s) => s.sessionId === selected)
        if (!stillThere) setSelected(sessions[0].sessionId)
      }, [sessions, selected, open])

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
            // Refresh straight away so the click feels immediate.
            setNonce((n) => n + 1)
          } catch (cause) {
            setNote(cause.message)
          }
        },
        [selected],
      )

      /**
       * Translate a click on the <img> into display pixels.
       *
       * The frame is scaled to the panel width, so the offset has to be
       * rescaled by naturalWidth/offsetWidth or every click lands short.
       */
      const onClick = useCallback(
        (event) => {
          const image = imageRef.current
          if (image === null || image.naturalWidth === 0) return
          const rect = image.getBoundingClientRect()
          const scaleX = image.naturalWidth / rect.width
          const scaleY = image.naturalHeight / rect.height
          const x = Math.round((event.clientX - rect.left) * scaleX)
          const y = Math.round((event.clientY - rect.top) * scaleY)
          void inject({ kind: 'click', x, y })
        },
        [inject],
      )

      const target = sessions.find((s) => s.sessionId === selected)

      const toggle = h(
        'button',
        {
          type: 'button',
          style: styles.button,
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open,
        },
        open ? 'Hide virtual display' : 'Virtual display',
      )

      if (!open) {
        return h('div', { style: styles.root }, h('div', { style: styles.row }, toggle))
      }

      const picker =
        sessions.length === 0
          ? h('span', { style: styles.empty }, 'No live sessions. Start one with the virtual_display tool.')
          : h(
              'select',
              {
                style: styles.select,
                value: selected,
                onChange: (event) => setSelected(event.target.value),
                'aria-label': 'Virtual display session',
              },
              sessions.map((s) =>
                h(
                  'option',
                  { key: s.sessionId, value: s.sessionId },
                  `${s.backend ?? s.platform ?? 'session'}${s.display !== undefined ? ` :${s.display}` : ''} — ${s.sessionId.slice(0, 8)}`,
                ),
              ),
            )

      const frame =
        src === null
          ? h('div', { style: styles.empty }, 'Waiting for a frame…')
          : h('div', { style: styles.stage },
              h('img', {
                ref: imageRef,
                src,
                alt: 'Private virtual display',
                style: styles.image,
                onClick,
              }))

      return h(
        'div',
        { style: styles.root },
        h('div', { style: styles.row }, toggle, picker),
        frame,
        h(
          'div',
          { style: styles.row },
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              onClick: () => void inject({ kind: 'key', key: 'Return' }),
              disabled: selected === '',
            },
            'Enter',
          ),
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              onClick: () => void inject({ kind: 'scroll', direction: 'down', amount: 3 }),
              disabled: selected === '',
            },
            'Scroll',
          ),
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              onClick: () => setNonce((n) => n + 1),
            },
            'Refresh',
          ),
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              onClick: () => setIntervalMs((ms) => (ms === 1000 ? 3000 : 1000)),
            },
            intervalMs === 1000 ? 'Slow' : 'Fast',
          ),
        ),
        h('div', { style: styles.hint }, 'Click the frame to send a click at that point.'),
        target?.warning !== undefined ? h('div', { style: styles.hint }, target.warning) : null,
        listError !== null ? h('div', { style: styles.error }, listError) : null,
        frameError !== null ? h('div', { style: styles.error }, frameError) : null,
        note !== null ? h('div', { style: styles.error }, note) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'virtual-display-panel', order: 40 },
            VirtualDisplayPanel,
          ),
        )
      },
    }
  },
})
