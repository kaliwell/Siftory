const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { loadTsModule } = require('./guard-utils.cjs')

const terms = {
  title: 'Siftory terms',
  version: '1.0',
  publisher: 'Test publisher',
  text: 'First line\nSecond line',
  sha256: 'a'.repeat(64),
}

function loadComponent(react) {
  const filename = path.resolve(__dirname, '../src/components/EndUserTermsDialog.tsx')
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod.require = (id) => {
    if (id === 'react') return react
    if (id.endsWith('.css')) return {}
    if (id === '../i18n/core') return loadTsModule('src/i18n/core.ts')
    throw new Error(`Unexpected component dependency: ${id}`)
  }
  mod._compile(output, filename)
  return mod.exports.default
}

// This fixture executes the component's handlers and hook lifecycle without
// launching Electron or reading application state. Browser rendering and native
// focus traversal remain the responsibility of the isolated window smoke test.
function fixture(t, props) {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const savedElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  const document = { activeElement: null }
  class Element {
    isConnected = true
    focus() {
      document.activeElement = this
    }
  }
  const previousFocus = new Element()
  previousFocus.focus()
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Element })
  t.after(() => {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument)
    else delete globalThis.document
    if (savedElement) Object.defineProperty(globalThis, 'HTMLElement', savedElement)
    else delete globalThis.HTMLElement
  })
  let slots = []
  let cursor = 0
  let effects = []
  let cleanups = []
  let key
  let nodes
  let tree
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value) => (slots[index] = value)]
    },
    useRef: (initial) => {
      const index = cursor++
      return (slots[index] ??= { current: initial })
    },
    useId: () => `test-id-${cursor++}`,
    useEffect: (fn) => {
      const index = cursor++
      if (!(index in slots)) {
        slots[index] = true
        effects.push(fn)
      }
    },
  }
  const Component = loadComponent(react)
  function render(next = props) {
    props = next
    const wrapper = Component(props)
    if (wrapper.props.key !== key) {
      cleanups.forEach((cleanup) => cleanup?.())
      cleanups = []
      slots = []
      key = wrapper.props.key
    }
    cursor = 0
    tree = wrapper.type(wrapper.props)
    nodes = []
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      node.element = new Element()
      if (node.props.ref) node.props.ref.current = node.element
      nodes.push(node)
      node.props.children.flat(Infinity).forEach(visit)
    }
    visit(tree)
    tree.element.contains = (element) => nodes.some((node) => node.element === element)
    tree.element.querySelectorAll = () =>
      nodes
        .filter(
          (node) =>
            (['button', 'input'].includes(node.type) && !node.props.disabled) ||
            node.props.tabIndex === 0,
        )
        .map((node) => node.element)
    for (const effect of effects) cleanups.push(effect())
    effects = []
  }
  render()
  return {
    render,
    get: (id) => nodes.find((node) => node.props['data-testid'] === `end-user-terms-${id}`),
    document,
    previousFocus,
    keyDown: (key, shiftKey = false) => {
      const event = {
        key,
        shiftKey,
        prevented: false,
        preventDefault() {
          this.prevented = true
        },
        stopPropagation() {},
      }
      tree.props.onKeyDown(event)
      return event
    },
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
  }
}

test('agreement starts unchecked and requires an explicit click after checking', (t) => {
  let accepts = 0
  let rejects = 0
  const props = {
    terms,
    mode: 'accept',
    language: 'en',
    onAccept: () => accepts++,
    onReject: () => rejects++,
  }
  const ui = fixture(t, props)
  assert.equal(ui.get('checkbox').props.checked, false)
  assert.equal(ui.get('accept').props.disabled, true)
  ui.get('accept').props.onClick()
  assert.equal(accepts, 0)
  ui.get('checkbox').props.onChange({ currentTarget: { checked: true } })
  ui.render()
  assert.equal(ui.get('accept').props.disabled, false)
  assert.equal(accepts, 0)
  ui.get('accept').props.onClick()
  assert.equal(accepts, 1)
  ui.get('reject').props.onClick()
  assert.equal(rejects, 1)
})

test('a different document resets a previous agreement', (t) => {
  const props = { terms, mode: 'accept', onAccept() {}, onReject() {}, language: 'en' }
  const ui = fixture(t, props)
  ui.get('checkbox').props.onChange({ currentTarget: { checked: true } })
  ui.render()
  assert.equal(ui.get('checkbox').props.checked, true)
  ui.render({ ...props, terms: { ...terms, sha256: 'b'.repeat(64) } })
  assert.equal(ui.get('checkbox').props.checked, false)
  assert.equal(ui.get('accept').props.disabled, true)
})

test('busy state disables all decisions and prevents callback invocation', (t) => {
  let actions = 0
  const props = {
    terms,
    mode: 'accept',
    onAccept: () => actions++,
    onReject: () => actions++,
    language: 'en',
  }
  const ui = fixture(t, props)
  ui.get('checkbox').props.onChange({ currentTarget: { checked: true } })
  ui.render({ ...props, busy: true })
  for (const id of ['accept', 'reject', 'checkbox']) assert.equal(ui.get(id).props.disabled, true)
  ui.get('accept').props.onClick()
  ui.get('reject').props.onClick()
  ui.keyDown('Escape')
  assert.equal(actions, 0)
})

test('view mode offers only close; Escape never implies consent or rejection', (t) => {
  let closes = 0
  const props = { terms, mode: 'view', onClose: () => closes++, language: 'en' }
  const ui = fixture(t, props)
  assert.equal(ui.get('checkbox'), undefined)
  assert.equal(ui.get('accept'), undefined)
  assert.equal(ui.get('reject'), undefined)
  ui.get('close').props.onClick()
  assert.equal(closes, 1)
  assert.equal(ui.keyDown('Escape').prevented, true)
  assert.equal(closes, 2)
  ui.render({ ...props, busy: true })
  ui.keyDown('Escape')
  ui.get('close').props.onClick()
  assert.equal(closes, 2)
  ui.render({ terms, mode: 'accept', onAccept: () => closes++, onReject: () => closes++ })
  ui.keyDown('Escape')
  ui.keyDown('Enter')
  assert.equal(closes, 2)
})

test('focus starts on full text, wraps both directions, and restores on unmount', (t) => {
  const ui = fixture(t, { terms, mode: 'view', onClose() {}, language: 'en' })
  assert.equal(ui.document.activeElement, ui.get('text').element)
  assert.equal(ui.keyDown('Tab', true).prevented, true)
  assert.equal(ui.document.activeElement, ui.get('close').element)
  assert.equal(ui.keyDown('Tab').prevented, true)
  assert.equal(ui.document.activeElement, ui.get('text').element)
  ui.unmount()
  assert.equal(ui.document.activeElement, ui.previousFocus)
})

test('React renders document content as literal text, with localized controls and visible errors', () => {
  const Component = loadComponent(React)
  const markup = renderToStaticMarkup(
    React.createElement(Component, {
      terms: { ...terms, text: '<script>alert(1)</script>\n[link](https://example.invalid)' },
      mode: 'accept',
      language: 'zh-CN',
      onAccept() {},
      onReject() {},
      error: '保存失败，请重试。',
    }),
  )
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(markup, /<script|<a\b|\bchecked="/)
  assert.match(markup, /我已阅读并同意以上条款。/)
  assert.match(markup, /同意并继续/)
  assert.match(markup, /拒绝并退出/)
  assert.match(markup, /role="alert">保存失败，请重试。/)
  assert.match(markup, /aria-modal="true"/)
  assert.match(markup, /Terms version|条款版本/)
})
