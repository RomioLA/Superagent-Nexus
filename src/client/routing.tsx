/** Model routing page: the live model catalog, channel availability, quota readings, quality evidence and the shared recommendation. */
import type { ReactNode } from 'react'
import { usePoll } from './api.ts'
import type { ApiResponse } from '../app/api.ts'
import { usePanel } from './provider.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'

type Routing = ApiResponse<'GET models/routing'>
type RoleModel = Routing['roles']['orchestrator']
type Channel = Routing['channels'][number]

/** Render a configured role model as `provider/model`, tolerating the object shape the settings hold. */
function roleModel(value: RoleModel | undefined): string {
  if (!value || typeof value !== 'object') return '—'
  const model = value as { provider?: string; model?: string }
  return [model.provider, model.model].filter(Boolean).join('/') || '—'
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="dt-lv"><span className="dt-lv-label">{label}</span><span className="dt-lv-value">{children}</span></div>
}

function ChannelRow({ channel }: { channel: Channel }) {
  const { t } = usePanel()
  return <tr>
    <td className="dt-mono">{channel.harness}{channel.model ? `/${channel.model}` : ''}</td>
    <td>{channel.provider ?? '—'}</td>
    <td>{channel.availability}</td>
    <td>{channel.remaining ?? '—'}</td>
    <td>{channel.resets_at ?? '—'}</td>
    <td>{channel.selectable ? t('yes') : `${t('no')}${channel.excluded_because ? ` (${channel.excluded_because})` : ''}`}</td>
    <td className="dt-hint">{channel.reason}</td>
  </tr>
}

export function ModelsPage() {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET models/routing'), [], 30_000)
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
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
    <Section title={t('modelChannels')} count={data.channels.length}>
      {data.channels.length ? <table className="dt-table">
        <thead><tr>
          <th>{t('modelColumnHarness')}</th><th>{t('modelColumnProvider')}</th><th>{t('modelColumnAvailability')}</th>
          <th>{t('modelColumnRemaining')}</th><th>{t('modelColumnResets')}</th><th>{t('modelColumnSelectable')}</th>
          <th>{t('modelColumnReason')}</th>
        </tr></thead>
        <tbody>{data.channels.map(channel => <ChannelRow key={`${channel.harness}/${channel.model}`} channel={channel} />)}</tbody>
      </table> : <Hint>{t('modelNoChannels')}</Hint>}
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
