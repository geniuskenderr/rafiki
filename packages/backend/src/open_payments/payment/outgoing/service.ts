import { ForeignKeyViolationError, TransactionOrKnex } from 'objection'

import { Pagination } from '../../../shared/baseModel'
import { BaseService } from '../../../shared/baseService'
import { FundingError, LifecycleError, OutgoingPaymentError } from './errors'
import { sendWebhookEvent } from './lifecycle'
import {
  OutgoingPayment,
  PaymentAmount,
  PaymentState,
  PaymentEventType
} from './model'
import { AccountingService } from '../../../accounting/service'
import { AccountService } from '../../account/service'
import { RatesService } from '../../../rates/service'
import { IlpPlugin, IlpPluginOptions } from './ilp_plugin'
import * as worker from './worker'

export interface OutgoingPaymentService {
  get(id: string): Promise<OutgoingPayment | undefined>
  create(
    options: CreateOutgoingPaymentOptions
  ): Promise<OutgoingPayment | OutgoingPaymentError>
  authorize(id: string): Promise<OutgoingPayment | OutgoingPaymentError>
  fund(
    options: FundOutgoingPaymentOptions
  ): Promise<OutgoingPayment | FundingError>
  processNext(): Promise<string | undefined>
  getAccountPage(
    accountId: string,
    pagination?: Pagination
  ): Promise<OutgoingPayment[]>
}

export interface ServiceDependencies extends BaseService {
  knex: TransactionOrKnex
  slippage: number
  quoteLifespan: number // milliseconds
  accountingService: AccountingService
  accountService: AccountService
  ratesService: RatesService
  makeIlpPlugin: (options: IlpPluginOptions) => IlpPlugin
}

export async function createOutgoingPaymentService(
  deps_: ServiceDependencies
): Promise<OutgoingPaymentService> {
  const deps = {
    ...deps_,
    logger: deps_.logger.child({ service: 'OutgoingPaymentService' })
  }
  return {
    get: (id) => getOutgoingPayment(deps, id),
    create: (options: CreateOutgoingPaymentOptions) =>
      createOutgoingPayment(deps, options),
    authorize: (id) => authorizePayment(deps, id),
    fund: (options) => fundPayment(deps, options),
    processNext: () => worker.processPendingPayment(deps),
    getAccountPage: (accountId, pagination) =>
      getAccountPage(deps, accountId, pagination)
  }
}

async function getOutgoingPayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment | undefined> {
  return OutgoingPayment.query(deps.knex)
    .findById(id)
    .withGraphJoined('account.asset')
}

export interface CreateOutgoingPaymentOptions {
  accountId: string
  authorized?: boolean
  sendAmount?: PaymentAmount
  receiveAmount?: PaymentAmount
  receivingAccount?: string
  receivingPayment?: string
  description?: string
  externalRef?: string
}

async function createOutgoingPayment(
  deps: ServiceDependencies,
  options: CreateOutgoingPaymentOptions
): Promise<OutgoingPayment | OutgoingPaymentError> {
  if (options.receivingPayment) {
    if (options.receivingAccount) {
      return OutgoingPaymentError.InvalidDestination
    }
    if (options.sendAmount || options.receiveAmount) {
      return OutgoingPaymentError.InvalidAmount
    }
  } else if (options.receivingAccount) {
    if (!options.sendAmount === !options.receiveAmount) {
      return OutgoingPaymentError.InvalidAmount
    }
  } else {
    return OutgoingPaymentError.InvalidDestination
  }

  try {
    const account = await deps.accountService.get(options.accountId)
    if (!account) {
      return OutgoingPaymentError.UnknownAccount
    }
    if (options.sendAmount) {
      if (options.sendAmount.assetCode || options.sendAmount.assetScale) {
        if (
          options.sendAmount.assetCode !== account.asset.code ||
          options.sendAmount.assetScale !== account.asset.scale
        ) {
          return OutgoingPaymentError.InvalidAmount
        }
      }
      ;(options.sendAmount.assetCode = account.asset.code),
        (options.sendAmount.assetScale = account.asset.scale)
    }

    return await OutgoingPayment.transaction(deps.knex, async (trx) => {
      const payment = await OutgoingPayment.query(trx)
        .insertAndFetch({
          ...options,
          state: PaymentState.Pending
        })
        .withGraphFetched('account.asset')

      await deps.accountingService.createLiquidityAccount({
        id: payment.id,
        asset: payment.account.asset
      })

      return payment
    })
  } catch (err) {
    if (err instanceof ForeignKeyViolationError) {
      return OutgoingPaymentError.UnknownAccount
    }
    throw err
  }
}

async function authorizePayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment | OutgoingPaymentError> {
  // TODO: introspect access token
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx)
      .findById(id)
      .forUpdate()
      .withGraphFetched('account.asset')
    if (!payment) return OutgoingPaymentError.UnknownPayment
    if (payment.state === PaymentState.Prepared) {
      await payment.$query(trx).patch({
        authorized: true,
        state: PaymentState.Funding
      })
      await sendWebhookEvent(deps, payment, PaymentEventType.PaymentFunding)
    } else if (payment.state === PaymentState.Pending && !payment.authorized) {
      await payment.$query(trx).patch({ authorized: true })
    } else {
      return OutgoingPaymentError.WrongState
    }
    return payment
  })
}

export interface FundOutgoingPaymentOptions {
  id: string
  amount: bigint
  transferId: string
}

async function fundPayment(
  deps: ServiceDependencies,
  { id, amount, transferId }: FundOutgoingPaymentOptions
): Promise<OutgoingPayment | FundingError> {
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx)
      .findById(id)
      .forUpdate()
      .withGraphFetched('account.asset')
    if (!payment) return FundingError.UnknownPayment
    if (payment.state !== PaymentState.Funding) {
      return FundingError.WrongState
    }
    if (!payment.sendAmount) throw LifecycleError.MissingSendAmount
    if (amount !== payment.sendAmount.amount) return FundingError.InvalidAmount
    const error = await deps.accountingService.createDeposit({
      id: transferId,
      account: payment,
      amount
    })
    if (error) {
      return error
    }
    await payment.$query(trx).patch({ state: PaymentState.Sending })
    return payment
  })
}

async function getAccountPage(
  deps: ServiceDependencies,
  accountId: string,
  pagination?: Pagination
): Promise<OutgoingPayment[]> {
  return await OutgoingPayment.query(deps.knex)
    .getPage(pagination)
    .where({ accountId })
}
