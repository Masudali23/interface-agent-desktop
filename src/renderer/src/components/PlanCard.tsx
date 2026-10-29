import type { PlanItem, PlanStatus, PlanView } from '../lib/timeline'
import { Icon } from './Icon'

function PlanIcon({ status, live }: { status: PlanStatus; live: boolean }) {
  if (status === 'completed') return <Icon name="checkCircle" size={15} className="tx-plan-icon done" />
  if (status === 'in_progress') return <span className={`tx-plan-ring ${live ? 'spinning' : ''}`} aria-hidden="true" />
  return (
    <svg className="tx-plan-icon pending" width={15} height={15} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={1.8} strokeDasharray="3.2 3.2" />
    </svg>
  )
}

const STATUS_LABEL: Record<PlanStatus, string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Done' }

export function PlanList({ items, live = false }: { items: PlanItem[]; live?: boolean }) {
  return (
    <ul className="tx-plan-list">
      {items.map((item, i) => (
        <li key={i} className={`tx-plan-item ${item.status}`}>
          <PlanIcon status={item.status} live={live} />
          <span className="tx-plan-text">{item.text}</span>
          <span className="tx-sr">{STATUS_LABEL[item.status]}</span>
        </li>
      ))}
    </ul>
  )
}

/** The turn's task list, shown once at the top of its latest part. */
export function PlanCard({ plan, live }: { plan: PlanView; live: boolean }) {
  const done = plan.items.filter((item) => item.status === 'completed').length
  return (
    <section className="tx-plan" aria-label={`Task list, ${done} of ${plan.items.length} done`}>
      {plan.carried && <div className="tx-plan-caption">Plan from before your last message</div>}
      <PlanList items={plan.items} live={live} />
    </section>
  )
}
