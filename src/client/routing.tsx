/** Model routing page: the live model catalog, Harness/channel availability and quota, model scanning, authorization and quality. */
import { useState, type ReactNode } from 'react'
import { usePoll } from './api.ts'
import type { ApiResponse } from '../app/api.ts'
import { Button, Switch } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'

type Routing = ApiResponse<'GET models/routing'>
type Scan = ApiResponse<'POST models/scan'>
type RoleModel = Routing['roles']['orchestrator']
type Channel = Routing['channels'][number]
type Harness = Routing['harnesses'][number]

/** Render a configured role model as `provider/model`, tolerating the object shape the settings hold. */
function roleModel(value: RoleModel | undefined): string {
  if (!value || typeof value !== 'object') return '—'
  const model = value as { provider?: string; model?: string }
  return [model.provider, model.model].filter(Boolean).join('/') || '—'
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="dt-lv"><span className="dt-lv-label">{label}</span><span className="dt-lv-value">{children}</span></div>
}

export function ModelsPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET models/routing'), [], 30_000)
  const [scan, setScan] = useState<Scan | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<Error | undefined>(undefined)
  if (!data) return <LoadState error={error} loading />

  const auth = data.authorization
  const enabled = (key: string): boolean => !auth.explicit || (auth.enabled ?? []).includes(key)
  const channelKey = (channel: Channel): string => channel.harness === 'dsh' ? `dsh/${channel.model}` : channel.harness
  const allKeys = (): string[] => {
    const keys = new Set<string>()
    for (const channel of data.channels) keys.add(channelKey(channel))
    // DSH is authorized per model (via channel keys above); a bare `dsh` key would re-authorize every model, so never add it.
    for (const harness of data.harnesses) if (harness.harness !== 'dsh') keys.add(harness.harness)
    return [...keys]
  }
  /** Toggle one logical route; saving an explicit set is what makes the Router stop auto-selecting it. */
  const toggle = async (key: string): Promise<void> => {
    const next = auth.explicit ? new Set(auth.enabled ?? []) : new Set(allKeys())
    if (next.has(key)) next.delete(key); else next.add(key)
    try { setActionError(undefined); await call('PUT models/selection', { body: { enabled: [...next] } }); await reload() }
    catch (failure) { setActionError(failure instanceof Error ? failure : new Error(String(failure))) }
  }
  const runScan = async (): Promise<void> => {
    setBusy(true); setActionError(undefined)
    try { setScan(await call('POST models/scan')); await reload() }
    catch (failure) { setActionError(failure instanceof Error ? failure : new Error(String(failure))) }
    finally { setBusy(false) }
  }

  return <>
    {error && <LoadState error={error} loading={false} />}
    {actionError && <LoadState error={actionError} loading={false} />}
    <Hint>{t('modelRoutingIntro')}</Hint>
    <Section title={t('modelRoles')}>
      <div className="dt-lvs">
        <Row label={`${t('modelRoleOrchestrator')}`}>{roleModel(data.roles.orchestrator)}</Row>
        <Row label={`${t('term.executor')}`}>{roleModel(data.roles.worker)}</Row>
      </div>
    </Section>
    <Section title={t('modelCatalog')}>
      <div className="dt-stats">{data.providers.map(provider => <span className="dt-stat" key={provider.id}>
        <span className="dt-stat-label">{provider.name}</span><span className="dt-stat-value">{provider.count}</span>
      </span>)}</div>
    </Section>
    <Section title={t('modelDiscovered')} count={data.discovered.length}>
      <Hint>{t('modelDiscoveredHint')}</Hint>
      {data.discovered.length ? <table className="dt-table">
        <thead><tr>
          <th>{t('modelColumnProvider')}</th><th>{t('modelColumnModel')}</th><th>{t('modelColumnState')}</th><th>{t('modelColumnAvailability')}</th>
        </tr></thead>
        <tbody>{data.discovered.map(item => <tr key={`${item.harness}/${item.provider}/${item.model}`}>
          <td>{item.provider}</td>
          <td className="dt-mono">{item.harness}/{item.model}</td>
          <td>{item.state === 'executable' ? t('modelStateExecutable')
            : item.state === 'availability-unknown' ? t('modelStateAvailabilityUnknown') : t('modelStateDiscovered')}</td>
          <td>{item.availability}</td>
        </tr>)}</tbody>
      </table> : <Hint>{t('modelNoDiscovered')}</Hint>}
    </Section>
    <Section title={t('modelHarnessAvailability')} count={data.harnesses.length}>
      <Hint>{t('modelScanCodexHint')}</Hint>
      {data.harnesses.length ? <table className="dt-table">
        <thead><tr>
          <th>{t('modelColumnHarness')}</th><th>{t('modelColumnState')}</th><th>{t('modelColumnRemaining')}</th>
          <th>{t('modelColumnResets')}</th><th>{t('modelColumnSource')}</th><th>{t('modelColumnAuthorized')}</th><th>{t('modelColumnReason')}</th>
        </tr></thead>
        <tbody>{data.harnesses.map(harness => <tr key={harness.harness}>
          <td className="dt-mono">{harness.harness}</td>
          <td>{harness.harness !== 'dsh' && !harness.installed ? t('modelToolNotInstalled') : harness.state}</td>
          <td>{harness.remaining ?? '—'}</td>
          <td>{harness.resets_at ?? '—'}</td>
          <td className="dt-hint">{harness.source}</td>
          <td>{harness.harness === 'dsh'
            ? <span className="dt-hint">{t('modelAuthorizationHint')}</span>
            : harness.installed
              ? <Switch checked={enabled(harness.harness)} onChange={() => void toggle(harness.harness)} label={harness.harness} />
              : <span className="dt-hint">{t('modelToolNotInstalled')}</span>}</td>
          <td className="dt-hint">{harness.evidence ?? '—'}</td>
        </tr>)}</tbody>
      </table> : <Hint>{t('modelNoHarness')}</Hint>}
    </Section>
    <Section title={t('modelScan')} action={<Button onClick={() => void runScan()} disabled={busy}>
      {busy ? t('modelScanning') : t('modelScanButton')}</Button>}>
      {data.scan ? <Hint>{t('modelLastScan', { at: data.scan.fetched_at })}</Hint> : <Hint>{t('modelNeverScanned')}</Hint>}
      {scan && (scan.first ? <Hint>{t('modelScanFirst')}</Hint> : <div className="dt-lvs">
        <Row label={t('modelScanAdded')}>{scan.diff.catalog.added.length ? scan.diff.catalog.added.join(', ') : '—'}</Row>
        <Row label={t('modelScanRemoved')}>{scan.diff.catalog.removed.length ? scan.diff.catalog.removed.join(', ') : '—'}</Row>
        <Row label={t('modelScanChanged')}>{scan.diff.availability.changed.length
          ? scan.diff.availability.changed.map(change => `${change.channel}: ${change.from}→${change.to}`).join('; ') : '—'}</Row>
      </div>)}
      {scan ? <Row label={t('modelTools')}>{scan.tools.map(tool => `${tool.name}: ${!tool.installed ? t('modelToolNotInstalled')
        : tool.status === 'unsupported' ? t('modelToolUnsupported') : t('modelToolCallableUnknown')}`).join(', ')}</Row> : null}
    </Section>
    <Section title={t('modelChannels')} count={data.channels.length}>
      {data.channels.length ? <table className="dt-table">
        <thead><tr>
          <th>{t('modelColumnHarness')}</th><th>{t('modelColumnProvider')}</th><th>{t('modelColumnAvailability')}</th>
          <th>{t('modelColumnRemaining')}</th><th>{t('modelColumnResets')}</th><th>{t('modelColumnSelectable')}</th>
          <th>{t('modelColumnAuthorized')}</th><th>{t('modelColumnReason')}</th>
        </tr></thead>
        <tbody>{data.channels.map(channel => <tr key={`${channel.harness}/${channel.model}`}>
          <td className="dt-mono">{channel.harness}{channel.model ? `/${channel.model}` : ''}</td>
          <td>{channel.provider ?? '—'}</td>
          <td>{channel.availability}</td>
          <td>{channel.remaining ?? '—'}</td>
          <td>{channel.resets_at ?? '—'}</td>
          <td>{channel.selectable ? t('yes') : `${t('no')}${channel.excluded_because ? ` (${channel.excluded_because})` : ''}`}</td>
          <td><Switch checked={enabled(channelKey(channel))} onChange={() => void toggle(channelKey(channel))}
            label={`${channel.harness}/${channel.model}`} /></td>
          <td className="dt-hint">{channel.reason}</td>
        </tr>)}</tbody>
      </table> : <Hint>{t('modelNoChannels')}</Hint>}
      <Hint>{t('modelAuthorizationHint')}</Hint>
      {data.checked_at && <Hint>{t('modelCheckedAt', { at: data.checked_at })}</Hint>}
    </Section>
    <Section title={t('modelRecommendation')}>
      {data.preferred ? <div className="dt-lvs">
        <Row label={t('modelColumnHarness')}>{data.preferred.harness}/{data.preferred.model}</Row>
        <Row label={t('modelColumnReason')}>{data.preferred.reason}</Row>
      </div> : <Hint>{t('modelNoFixedRank')}</Hint>}
      <Hint>{t('modelAskRouter')}</Hint>
    </Section>
    <Section title={t('modelQuota')}>
      <div className="dt-lvs">
        <Row label={t('modelCodexStatus')}>{data.codex.status}</Row>
        <Row label={t('modelColumnReason')}>{data.codex.reason}</Row>
      </div>
    </Section>
    <Section title={t('modelQuality')}>
      <Hint>{t('modelQualityInsufficient')}</Hint>
      <p className="dt-hint">{data.quality.note}</p>
    </Section>
    {data.unknown.length > 0 && <Section title={t('modelUnknown')}>
      <ul className="dt-list">{data.unknown.map(item => <li key={item} className="dt-hint dt-mono">{item}</li>)}</ul>
    </Section>}
  </>
}
