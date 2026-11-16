// @vitest-environment jsdom
// The model routing page.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, tab, click, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('shows the model routing page from the shared routing view', async () => {
  await mount()
  await click(tab(zh['tab.models']))
  expect(tab(zh['tab.models']).getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path === 'models/routing' && request.method === 'GET')).toBe(true)
  // Channel identity, availability and remaining quota come from the routing projection, not a second table.
  expect(text()).toContain('dsh/worker-model')
  expect(text()).toContain('42')
  // Discovered models show their provider and the executable/availability-unknown distinction.
  expect(text()).toContain(zh.modelDiscovered)
  expect(text()).toContain('Worker provider')
  expect(text()).toContain(zh.modelStateExecutable)
  // A Harness whose CLI was not detected is shown as not installed instead of an authorizable channel.
  expect(text()).toContain(zh.modelToolNotInstalled)
  expect(text()).toContain('Selected dsh/worker-model by configured priority 0')
  expect(text()).toContain('Codex account availability is unknown')
  // Quality is reported as insufficient rather than shown as a fabricated score.
  expect(text()).toContain(zh.modelQualityInsufficient)
})

it('authorizes concrete external models individually and shows unknown quota windows honestly', async () => {
  await mount()
  await click(tab(zh['tab.models']))
  // A dispatchable Codex model has its own switch; a hidden (non-dispatchable) model stays read-only.
  expect(document.querySelector('[role="switch"][aria-label="codex/gpt-6-luna"]')).toBeTruthy()
  expect(document.querySelector('[role="switch"][aria-label="codex/hidden-model"]')).toBeNull()
  expect(text()).toContain(zh.modelNotAuthorizable)
  // Disabling the model saves an explicit set that excludes it, so it cannot be auto-selected later.
  await click('codex/gpt-6-luna')
  const put = server.requests.filter(request => request.path === 'models/selection' && request.method === 'PUT').at(-1)
  const enabled = (put?.body as { enabled: string[] }).enabled
  expect(enabled).not.toContain('codex/gpt-6-luna')
  expect(enabled).toContain('dsh/worker-model')
  // Codex quota windows are shown from the last snapshot with their reset time; unknown stays unknown, never fabricated.
  expect(text()).toContain('80%')
  expect(text()).toContain('300min')
  expect(text()).toContain('Codex account availability is unknown')
})
