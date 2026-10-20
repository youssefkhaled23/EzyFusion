'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { DatePicker } from '@/components/date-picker'
import { FormField } from '@/components/form-field'
import { SectionCard } from '@/components/section-card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { describeFailure, postJson } from '@/lib/api-client'
import { parseRinggitToSen } from '@/lib/billing'
import { parseIsoDate } from '@/lib/date'
import { formatDateMy } from '@/lib/format-my'
import type { LeaseFormOptions } from '@/server/domain/leases'

type Field = 'unit' | 'tenant' | 'startDate' | 'endDate' | 'rent' | 'deposit'
type Errors = Partial<Record<Field, string>>

export function LeaseForm({ options }: { options: LeaseFormOptions }) {
  const router = useRouter()
  const orgs = options.organizations
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '')
  const org = orgs.find((o) => o.id === orgId)
  const [unitId, setUnitId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rent, setRent] = useState('')
  const [deposit, setDeposit] = useState('0')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const units = org?.units ?? []
  const tenants = org?.tenants ?? []
  const unit = units.find((u) => u.id === unitId)
  const unitItems = units.map((u) => ({ value: u.id, label: u.name }))
  const tenantItems = tenants.map((t) => ({ value: t.id, label: `${t.fullName} (${t.email})` }))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setFormError(null)
    const next: Errors = {}
    if (!unitId) next.unit = 'Select a unit.'
    if (!tenantId) next.tenant = 'Select a tenant.'
    const start = parseIsoDate(startDate)
    const end = parseIsoDate(endDate)
    if (!start) next.startDate = 'Select the start date.'
    if (!end) next.endDate = 'Select the end date.'
    if (start && end && end < start) next.endDate = 'The end date must not be before the start date.'

    let monthlyRentSen = 0
    if (rent.trim() === '') next.rent = 'Enter the monthly rent.'
    else
    try {
      monthlyRentSen = parseRinggitToSen(rent)
      if (monthlyRentSen <= 0) next.rent = 'Monthly rent must be greater than zero.'
    } catch {
      next.rent = 'Enter the rent in ringgit, for example 1,500.00 (at most 2 decimals).'
    }
    let depositSen = 0
    try {
      depositSen = parseRinggitToSen(deposit === '' ? '0' : deposit)
    } catch {
      next.deposit = 'Enter the deposit in ringgit, for example 3,000.00 (use 0 for none).'
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return

    setSubmitting(true)
    const result = await postJson<{ id: string }>('/api/leases', { unitId, tenantId, startDate, endDate, monthlyRentSen, depositSen })
    if (!result.ok || !result.data) {
      const message = describeFailure(result.status, result.error)
      setFormError(message)
      toast.error(message)
      setSubmitting(false)
      return
    }
    toast.success('Lease created')
    router.push(`/leases/${result.data.id}`)
    router.refresh()
  }

  if (orgs.length === 0 || (units.length === 0 && orgs.length === 1) || (tenants.length === 0 && orgs.length === 1)) {
    return (
      <Alert data-testid="lease-form-empty">
        <AlertTitle>{units.length === 0 ? 'No units yet' : 'No tenants yet'}</AlertTitle>
        <AlertDescription>A lease needs an existing unit and an existing tenant in your organization. Units and tenants are added by an administrator.</AlertDescription>
      </Alert>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate data-testid="lease-form" className="space-y-6">
      {formError ? (
        <Alert variant="destructive" role="alert" data-testid="lease-form-error">
          <AlertTitle>Lease not created</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title="Unit and tenant" description="Only units and tenants of your own organization are listed.">
        <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
          {orgs.length > 1 ? (
            <FormField id="lease-org" label="Organization" className="md:col-span-2">
              {(field) => (
                <Select items={orgs.map((o) => ({ value: o.id, label: o.name }))} value={orgId} onValueChange={(v) => { setOrgId(v ?? ''); setUnitId(''); setTenantId('') }}>
                  <SelectTrigger id={field.id}><SelectValue /></SelectTrigger>
                  <SelectContent>{orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
                </Select>
              )}
            </FormField>
          ) : null}
          <FormField
            id="lease-unit"
            label="Unit"
            error={errors.unit}
            hint={unit && unit.leases.length > 0 ? `Already leased: ${unit.leases.map((l) => `${formatDateMy(l.startDate)} – ${formatDateMy(l.endDate)}`).join('; ')}` : unit ? 'No leases on this unit yet.' : 'The unit being leased.'}
          >
            {(field) => (
              <Select items={unitItems} value={unitId || null} onValueChange={(v) => setUnitId(v ?? '')}>
                <SelectTrigger id={field.id} aria-invalid={field['aria-invalid']} aria-describedby={field['aria-describedby']}><SelectValue placeholder="Select a unit" /></SelectTrigger>
                <SelectContent>{units.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </FormField>
          <FormField id="lease-tenant" label="Tenant" error={errors.tenant}>
            {(field) => (
              <Select items={tenantItems} value={tenantId || null} onValueChange={(v) => setTenantId(v ?? '')}>
                <SelectTrigger id={field.id} aria-invalid={field['aria-invalid']} aria-describedby={field['aria-describedby']}><SelectValue placeholder="Select a tenant" /></SelectTrigger>
                <SelectContent>{tenants.map((t) => <SelectItem key={t.id} value={t.id}>{t.fullName} ({t.email})</SelectItem>)}</SelectContent>
              </Select>
            )}
          </FormField>
        </div>
      </SectionCard>

      <SectionCard title="Term and rent" description="Dates are Malaysia calendar dates. Amounts are in ringgit (RM).">
        <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
          <FormField id="lease-start" label="Start date" error={errors.startDate}>
            {(field) => <DatePicker {...field} value={startDate} onChange={setStartDate} max={endDate || undefined} placeholder="Select the start date" />}
          </FormField>
          <FormField id="lease-end" label="End date" error={errors.endDate}>
            {(field) => <DatePicker {...field} value={endDate} onChange={setEndDate} min={startDate || undefined} placeholder="Select the end date" />}
          </FormField>
          <FormField id="lease-rent" label="Monthly rent (RM)" error={errors.rent} hint="Up to 2 decimals, for example 1,500.00">
            {(field) => (
              <div className="relative">
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground-strong">RM</span>
                <Input {...field} inputMode="decimal" autoComplete="off" className="pl-10 text-right num" placeholder="0.00" value={rent} onChange={(e) => setRent(e.target.value)} />
              </div>
            )}
          </FormField>
          <FormField id="lease-deposit" label="Deposit (RM)" error={errors.deposit} hint="Use 0 for no deposit.">
            {(field) => (
              <div className="relative">
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground-strong">RM</span>
                <Input {...field} inputMode="decimal" autoComplete="off" className="pl-10 text-right num" placeholder="0.00" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              </div>
            )}
          </FormField>
        </div>
      </SectionCard>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href="/leases" className={buttonVariants({ variant: 'outline' })}>Cancel</Link>
        <Button type="submit" disabled={submitting} aria-busy={submitting} data-testid="create-lease">
          {submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
          {submitting ? 'Creating…' : 'Create lease'}
        </Button>
      </div>
    </form>
  )
}
