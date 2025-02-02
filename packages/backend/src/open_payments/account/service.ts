import { TransactionOrKnex } from 'objection'

import { Account, AccountEvent, AccountEventType } from './model'
import { BaseService } from '../../shared/baseService'
import { AccountingService } from '../../accounting/service'
import { AssetService, AssetOptions } from '../../asset/service'

export interface CreateOptions {
  asset: AssetOptions
}

export interface AccountService {
  create(options: CreateOptions): Promise<Account>
  get(id: string): Promise<Account | undefined>
  processNext(): Promise<string | undefined>
  triggerEvents(limit: number): Promise<number>
}

interface ServiceDependencies extends BaseService {
  knex: TransactionOrKnex
  accountingService: AccountingService
  assetService: AssetService
}

export async function createAccountService({
  logger,
  knex,
  accountingService,
  assetService
}: ServiceDependencies): Promise<AccountService> {
  const log = logger.child({
    service: 'AccountService'
  })
  const deps: ServiceDependencies = {
    logger: log,
    knex,
    accountingService,
    assetService
  }
  return {
    create: (options) => createAccount(deps, options),
    get: (id) => getAccount(deps, id),
    processNext: () => processNextAccount(deps),
    triggerEvents: (limit) => triggerAccountEvents(deps, limit)
  }
}

async function createAccount(
  deps: ServiceDependencies,
  options: CreateOptions
): Promise<Account> {
  const asset = await deps.assetService.getOrCreate(options.asset)
  return await Account.transaction(deps.knex, async (trx) => {
    const account = await Account.query(trx)
      .insertAndFetch({
        assetId: asset.id
      })
      .withGraphFetched('asset')

    // SPSP fallback account
    await deps.accountingService.createLiquidityAccount({
      id: account.id,
      asset: account.asset
    })

    return account
  })
}

async function getAccount(
  deps: ServiceDependencies,
  id: string
): Promise<Account | undefined> {
  return await Account.query(deps.knex).findById(id).withGraphJoined('asset')
}

// Returns the id of the processed account (if any).
async function processNextAccount(
  deps: ServiceDependencies
): Promise<string | undefined> {
  const accounts = await processNextAccounts(deps, 1)
  return accounts[0]?.id
}

async function triggerAccountEvents(
  deps: ServiceDependencies,
  limit: number
): Promise<number> {
  const accounts = await processNextAccounts(deps, limit)
  return accounts.length
}

// Fetch (and lock) accounts for work.
// Returns the processed accounts (if any).
async function processNextAccounts(
  deps_: ServiceDependencies,
  limit: number
): Promise<Account[]> {
  return deps_.knex.transaction(async (trx) => {
    const now = new Date(Date.now()).toISOString()
    const accounts = await Account.query(trx)
      .limit(limit)
      // Ensure the accounts cannot be processed concurrently by multiple workers.
      .forUpdate()
      // If an account is locked, don't wait — just come back for it later.
      .skipLocked()
      .where('processAt', '<=', now)
      .withGraphFetched('asset')

    const deps = {
      ...deps_,
      knex: trx
    }

    for (const account of accounts) {
      deps.logger = deps_.logger.child({
        account: account.id
      })
      await createWithdrawalEvent(deps, account)
      await account.$query(deps.knex).patch({
        processAt: null
      })
    }

    return accounts
  })
}

// "account" must have been fetched with the "deps.knex" transaction.
async function createWithdrawalEvent(
  deps: ServiceDependencies,
  account: Account
): Promise<void> {
  const totalReceived = await deps.accountingService.getTotalReceived(
    account.id
  )
  if (!totalReceived) {
    deps.logger.warn({ totalReceived }, 'missing/empty balance')
    return
  }

  const amount = totalReceived - account.totalEventsAmount

  if (amount <= BigInt(0)) {
    deps.logger.warn(
      {
        totalReceived,
        totalEventsAmount: account.totalEventsAmount
      },
      'no amount to withdrawal'
    )
    return
  }

  deps.logger.trace({ amount }, 'creating webhook withdrawal event')

  await AccountEvent.query(deps.knex).insert({
    type: AccountEventType.AccountWebMonetization,
    data: account.toData(amount),
    withdrawal: {
      accountId: account.id,
      assetId: account.assetId,
      amount
    }
  })

  await account.$query(deps.knex).patch({
    totalEventsAmount: account.totalEventsAmount + amount
  })
}
