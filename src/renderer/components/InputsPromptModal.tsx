import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'

export function InputsPromptModal({ title, hint, fields, confirmLabel, initial, onSubmit, onClose }: {
  title: string
  hint?: string
  fields: string[]
  confirmLabel: string
  initial?: Record<string, string>
  onSubmit: (values: Record<string, string>) => void
  onClose: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>(initial ?? {})
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => { firstRef.current?.focus() }, [])

  // Cmd+Up/Down would otherwise switch worktrees while you're typing.
  useEffect(() => {
    useStore.getState().pushModal()
    return () => useStore.getState().popModal()
  }, [])

  // Every field is required: a blank one substitutes to empty and would be
  // handed to the command as an empty argument.
  const complete = fields.every(f => values[f]?.trim())

  const submit = () => {
    if (!complete) return
    onSubmit(Object.fromEntries(fields.map(f => [f, values[f].trim()])))
    onClose()
  }

  return (
    <div onClick={onClose}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '18vh' }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#2d2d2d', color: '#ddd', fontFamily: 'system-ui',
                    border: '1px solid #444', borderRadius: 8, padding: 18, width: 460,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.55)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</div>
        {hint && (
          <div style={{ fontSize: 11, color: '#888', marginBottom: 12, lineHeight: 1.5,
                        fontFamily: 'Menlo, monospace', wordBreak: 'break-all' }}>{hint}</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {fields.map((field, i) => (
            <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10.5, color: '#999', textTransform: 'uppercase',
                             letterSpacing: 0.5 }}>{field}</span>
              <input ref={i === 0 ? firstRef : undefined}
                     value={values[field] ?? ''}
                     placeholder={`{{${field}}}`}
                     onChange={e => setValues(v => ({ ...v, [field]: e.target.value }))}
                     onKeyDown={e => {
                       if (e.key === 'Enter') submit()
                       else if (e.key === 'Escape') onClose()
                     }}
                     style={{ width: '100%', background: '#1e1e1e', color: '#eee',
                              border: '1px solid #555', borderRadius: 5, padding: '7px 10px',
                              fontSize: 13, fontFamily: 'system-ui' }} />
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={!complete}
                  style={{ background: complete ? '#0e639c' : '#3a3a3a', color: '#fff', border: 'none',
                           padding: '5px 14px', borderRadius: 4,
                           cursor: complete ? 'pointer' : 'default' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
