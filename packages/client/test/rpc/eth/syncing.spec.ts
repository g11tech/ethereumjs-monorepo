import tape from 'tape'
import td from 'testdouble'
import { BN } from 'ethereumjs-util'
import { INTERNAL_ERROR } from '../../../lib/rpc/error-code'
import { baseRequest, createManager, createClient, params, startRPC } from '../helpers'
import { checkError } from '../util'

const method = 'eth_syncing'

tape(`${method}: should return false when the client is synchronized`, async (t) => {
  const client = createClient()
  const manager = createManager(client)
  const server = startRPC(manager.getMethods())

  client.config.synchronized = false
  t.equals(client.config.synchronized, false, 'not synchronized yet')
  client.config.synchronized = true
  t.equals(client.config.synchronized, true, 'synchronized')

  const req = params(method, [])
  const expectRes = (res: any) => {
    const msg = 'should return false'
    if (res.body.result === false) {
      t.pass(msg)
    } else {
      throw new Error(msg)
    }
  }
  await baseRequest(t, server, req, 200, expectRes)
})

tape(`${method}: should return no peer available error`, async (t) => {
  const client = createClient({ noPeers: true })
  const manager = createManager(client)
  const rpcServer = startRPC(manager.getMethods())

  client.config.synchronized = false
  t.equals(client.config.synchronized, false, 'not synchronized yet')

  const req = params(method, [])

  const expectRes = checkError(t, INTERNAL_ERROR, 'no peer available for synchronization')
  await baseRequest(t, rpcServer, req, 200, expectRes)
})

tape(`${method}: should return highest block header unavailable error`, async (t) => {
  const client = createClient()
  const manager = createManager(client)
  const rpcServer = startRPC(manager.getMethods())

  const synchronizer = client.services[0].synchronizer
  synchronizer.best = td.func<typeof synchronizer['best']>()
  td.when(synchronizer.best()).thenReturn('peer')

  client.config.synchronized = false
  t.equals(client.config.synchronized, false, 'not synchronized yet')

  const req = params(method, [])

  const expectRes = checkError(t, INTERNAL_ERROR, 'highest block header unavailable')
  await baseRequest(t, rpcServer, req, 200, expectRes)
})

tape(`${method}: should return syncing status object when unsynced`, async (t) => {
  const client = createClient()
  const manager = createManager(client)
  const rpcServer = startRPC(manager.getMethods())

  const synchronizer = client.services[0].synchronizer
  synchronizer.best = td.func<typeof synchronizer['best']>()
  synchronizer.latest = td.func<typeof synchronizer['latest']>()
  td.when(synchronizer.best()).thenReturn('peer')
  td.when(synchronizer.latest('peer' as any)).thenResolve({ number: new BN(2) })

  client.config.synchronized = false
  t.equals(client.config.synchronized, false, 'not synchronized yet')

  const req = params(method, [])
  const expectRes = (res: any) => {
    const msg = 'should return syncing status object'
    if (
      res.body.result.startingBlock === '0x0' &&
      res.body.result.currentBlock === '0x0' &&
      res.body.result.highestBlock === '0x2'
    ) {
      t.pass(msg)
    } else {
      throw new Error(msg)
    }
  }

  await baseRequest(t, rpcServer, req, 200, expectRes)
})

tape('should reset td', (t) => {
  td.reset()
  t.end()
})
