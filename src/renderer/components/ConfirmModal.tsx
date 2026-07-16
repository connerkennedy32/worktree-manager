interface Props {
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  error?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({ title, body, confirmLabel = 'Confirm', danger, busy, error, onConfirm, onCancel }: Props) {
  return (
    <div onClick={onCancel}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#2d2d2d', color: '#ddd', fontFamily: 'system-ui', fontSize: 13,
                    border: '1px solid #444', borderRadius: 6, padding: 20, width: 380,
                    boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{title}</div>
        <div style={{ color: '#bbb', lineHeight: 1.5, marginBottom: 16 }}>{body}</div>
        {error && <div style={{ color: '#f28b82', marginBottom: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button onClick={onConfirm} disabled={busy}
                  style={{ background: danger ? '#a1260d' : '#0e639c', color: '#fff', border: 'none',
                           padding: '4px 12px', borderRadius: 4, cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
