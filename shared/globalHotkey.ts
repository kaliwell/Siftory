/** Restrict stored accelerators to one main key and explicit, unique modifiers. */
export function normalizeGlobalHotkey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null
  const parts = value
    .trim()
    .split('+')
    .map((part) => part.trim())
  const modifiers = new Set<string>()
  let key = ''
  for (const part of parts) {
    const modifier = (
      {
        ctrl: 'CommandOrControl',
        control: 'CommandOrControl',
        commandorcontrol: 'CommandOrControl',
        shift: 'Shift',
        alt: 'Alt',
        meta: 'Super',
        super: 'Super',
        win: 'Super',
      } as Record<string, string>
    )[part.toLowerCase()]
    if (modifier) {
      if (modifiers.has(modifier)) return null
      modifiers.add(modifier)
    } else {
      if (key) return null
      if (/^[a-z0-9]$/i.test(part) || /^F(?:[1-9]|1\d|2[0-4])$/i.test(part))
        key = part.toUpperCase()
      else
        key =
          (
            {
              escape: 'Escape',
              space: 'Space',
              enter: 'Enter',
              tab: 'Tab',
              home: 'Home',
              end: 'End',
              pageup: 'PageUp',
              pagedown: 'PageDown',
              up: 'Up',
              down: 'Down',
              left: 'Left',
              right: 'Right',
            } as Record<string, string>
          )[part.toLowerCase()] ?? ''
      if (!key) return null
    }
  }
  if (!key || !modifiers.size) return null
  return [
    ...['CommandOrControl', 'Shift', 'Alt', 'Super'].filter((modifier) => modifiers.has(modifier)),
    key,
  ].join('+')
}

export function validateVisibilityHotkey(value: unknown, reserved: readonly string[]) {
  const accelerator = normalizeGlobalHotkey(value)
  if (!accelerator) return { accelerator: null, error: 'Invalid shortcut' }
  if (reserved.some((key) => normalizeGlobalHotkey(key) === accelerator))
    return { accelerator: null, error: 'Shortcut conflicts' }
  return { accelerator, error: undefined }
}
