import tape from 'tape'
import { Address, BN, keccak256, padToEven } from 'ethereumjs-util'
import Common, { Chain, Hardfork } from '@ethereumjs/common'
import VM from '../../src'

// Non-protected Create2Address generator. Does not check if buffers have the right padding.
function create2address(sourceAddress: Address, codeHash: Buffer, salt: Buffer): Address {
  const rlp_proc_buffer = Buffer.from('ff', 'hex')
  const hashBuffer = Buffer.concat([rlp_proc_buffer, sourceAddress.buf, salt, codeHash])
  return new Address(keccak256(hashBuffer).slice(12))
}

/*
    This test:
        Setups a contract at address 0x00..ff 
        Instantiates the VM at the Constantinople fork
        Calls the address with various arguments (callvalue is used as argument). VMs `runCall` is used.
        The CREATE2 address which the contract creates is checked against the expected CREATE2 value.
*/

tape('Constantinople: EIP-1014 CREATE2 creates the right contract address', async (t) => {
  // setup the accounts for this test
  const caller = new Address(Buffer.from('00000000000000000000000000000000000000ee', 'hex')) // caller addres
  const contractAddress = new Address(
    Buffer.from('00000000000000000000000000000000000000ff', 'hex')
  ) // contract address
  // setup the vm
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Constantinople })
  const vm = new VM({ common })
  const code = '3460008080F560005260206000F3'
  /*
      code:             remarks: (top of the stack is at the zero index)
        CALLVALUE
        PUSH1 0x00
        DUP1
        DUP1
        CREATE2         [0, 0, 0, CALLVALUE]
        PUSH1 0x00
        MSTORE          [0x00, <created address>]
        PUSH1 0x20
        PUSH1 0x00
        RETURN          [0x00, 0x20]
    */

  await vm.stateManager.putContractCode(contractAddress, Buffer.from(code, 'hex')) // setup the contract code

  const codeHash = keccak256(Buffer.from(''))
  for (let value = 0; value <= 1000; value += 20) {
    // setup the call arguments
    const runCallArgs = {
      caller: caller, // call address
      gasLimit: new BN(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
      to: contractAddress, // call to the contract address
      value: new BN(value), // call with this value (the value is used in the contract as an argument, see above's code)
    }

    const hexString = padToEven(value.toString(16))
    let valueBuffer = Buffer.from(hexString, 'hex')
    // pad buffer
    if (valueBuffer.length < 32) {
      const diff = 32 - valueBuffer.length
      valueBuffer = Buffer.concat([Buffer.alloc(diff), valueBuffer])
    }
    // calculate expected CREATE2 address
    const expectedAddress = create2address(contractAddress, codeHash, valueBuffer)
    // run the actual call
    const res = await vm.runCall(runCallArgs)
    // retrieve the return value and convert it to an address (remove the first 12 bytes from the 32-byte return value)
    const executionReturnValue = new Address(res.execResult.returnValue.slice(12))
    if (!expectedAddress.equals(executionReturnValue)) {
      t.fail('contract address not equal')
    }
  }

  t.pass('CREATE2 creates (empty) contracts at the expected address')

  t.end()
})

tape('Byzantium cannot access Constantinople opcodes', async (t) => {
  t.plan(2)
  // setup the accounts for this test
  const caller = new Address(Buffer.from('00000000000000000000000000000000000000ee', 'hex')) // caller addres
  const contractAddress = new Address(
    Buffer.from('00000000000000000000000000000000000000ff', 'hex')
  ) // contract address
  // setup the vm
  const vmByzantium = new VM({
    common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Byzantium }),
  })
  const vmConstantinople = new VM({
    common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Constantinople }),
  })
  const code = '600160011B00'
  /*
      code:             remarks: (top of the stack is at the zero index)
        PUSH1 0x01  
        PUSH1 0x01
        SHL
        STOP
    */

  await vmByzantium.stateManager.putContractCode(contractAddress, Buffer.from(code, 'hex')) // setup the contract code
  await vmConstantinople.stateManager.putContractCode(contractAddress, Buffer.from(code, 'hex')) // setup the contract code

  const runCallArgs = {
    caller: caller, // call address
    gasLimit: new BN(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
    to: contractAddress, // call to the contract address
  }

  const byzantiumResult = await vmByzantium.runCall(runCallArgs)
  const constantinopleResult = await vmConstantinople.runCall(runCallArgs)

  t.assert(
    byzantiumResult.execResult.exceptionError &&
      byzantiumResult.execResult.exceptionError.error === 'invalid opcode',
    'byzantium cannot accept constantinople opcodes (SHL)'
  )
  t.assert(
    !constantinopleResult.execResult.exceptionError,
    'constantinople can access the SHL opcode'
  )

  t.end()
})

tape('Ensure that precompile activation creates non-empty accounts', async (t) => {
  // setup the accounts for this test
  const caller = new Address(Buffer.from('00000000000000000000000000000000000000ee', 'hex')) // caller addres
  const contractAddress = new Address(
    Buffer.from('00000000000000000000000000000000000000ff', 'hex')
  ) // contract address
  // setup the vm
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Istanbul })
  const vmNotActivated = new VM({ common: common })
  const vmActivated = new VM({ common: common, activatePrecompiles: true })
  const code = '6000808080347300000000000000000000000000000000000000045AF100'
  /*
      idea: call the Identity precompile with nonzero value in order to trigger "callNewAccount" for the non-activated VM and do not deduct this
            when calling from the activated VM. Explicitly check that the difference in gas cost is equal to the common callNewAccount gas.
      code:             remarks: (top of the stack is at the zero index)       
        PUSH1 0x00
        DUP1
        DUP1
        DUP1
        CALLVALUE
        PUSH20 0000000000000000000000000000000000000004
        GAS
        CALL            [gas, 0x00..04, 0, 0, 0, 0, 0]
        STOP
    */

  await vmNotActivated.stateManager.putContractCode(contractAddress, Buffer.from(code, 'hex')) // setup the contract code
  await vmActivated.stateManager.putContractCode(contractAddress, Buffer.from(code, 'hex')) // setup the contract code

  // setup the call arguments
  const runCallArgs = {
    caller: caller, // call address
    gasLimit: new BN(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
    to: contractAddress, // call to the contract address,
    value: new BN(1),
  }

  const resultNotActivated = await vmNotActivated.runCall(runCallArgs)
  const resultActivated = await vmActivated.runCall(runCallArgs)

  const diff = resultNotActivated.gasUsed.sub(resultActivated.gasUsed)
  const expected = common.param('gasPrices', 'callNewAccount')

  t.assert(diff.eq(new BN(expected)), 'precompiles are activated')

  t.end()
})

tape('Ensure that Istanbul sstoreCleanRefundEIP2200 gas is applied correctly', async (t) => {
  // setup the accounts for this test
  const caller = new Address(Buffer.from('00000000000000000000000000000000000000ee', 'hex')) // caller addres
  const address = new Address(Buffer.from('00000000000000000000000000000000000000ff', 'hex'))
  // setup the vm
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Istanbul })
  const vm = new VM({ common: common })
  const code = '61000260005561000160005500'
  /*
      idea: store the original value in the storage slot, except it is now a 1-length buffer instead of a 32-length buffer
      code:             
        PUSH2 0x0002
        PUSH1 0x00
        SSTORE              -> make storage slot 0 "dirty"
        PUSH2 0x0001
        PUSH1 0x00          
        SSTORE              -> -> restore it to the original storage value (refund sstoreCleanRefundEIP2200)
        STOP
      gas cost: 
        4x PUSH                                         12
        2x SSTORE (slot is nonzero, so charge 5000): 10000
        net                                          10012
      gas refund 
        sstoreCleanRefundEIP2200                      4200
      gas used
                                                     10012 - 4200 = 5812

    */

  await vm.stateManager.putContractCode(address, Buffer.from(code, 'hex'))
  await vm.stateManager.putContractStorage(
    address,
    Buffer.alloc(32, 0),
    Buffer.from('00'.repeat(31) + '01', 'hex')
  )

  // setup the call arguments
  const runCallArgs = {
    caller: caller, // call address
    to: address,
    gasLimit: new BN(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
  }

  const result = await vm.runCall(runCallArgs)
  console.log(result.gasUsed, result.execResult.gasRefund)
  t.equal(result.gasUsed.toNumber(), 5812, 'gas used incorrect')
  t.equal(result.execResult.gasRefund!.toNumber(), 4200, 'gas refund incorrect')

  t.end()
})

tape('Ensure that IDENTITY precompile copies the memory', async (t) => {
  // This test replays the Geth chain split; https://etherscan.io/tx/0x1cb6fb36633d270edefc04d048145b4298e67b8aa82a9e5ec4aa1435dd770ce4
  // Exploit post-mortem: https://github.com/ethereum/go-ethereum/blob/master/docs/postmortems/2021-08-22-split-postmortem.md
  // Permalink: https://github.com/ethereum/go-ethereum/blob/90987db7334c1d10eb866ca550efedb66dea8a20/docs/postmortems/2021-08-22-split-postmortem.md
  // setup the accounts for this test
  const caller = new Address(Buffer.from('1a02a619e51cc5f8a2a61d2a60f6c80476ee8ead', 'hex')) // caller addres
  // setup the vm
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.London })
  const vm = new VM({ common: common })
  const code = '3034526020600760203460045afa602034343e604034f3'

  const account = await vm.stateManager.getAccount(caller)
  account.nonce = new BN(1) // ensure nonce for contract is correct
  account.balance = new BN('10000000000000000')
  await vm.stateManager.putAccount(caller, account)

  // setup the call arguments
  const runCallArgs = {
    caller: caller, // call address
    gasLimit: new BN(150000),
    data: Buffer.from(code, 'hex'),
    gasPrice: new BN(70000000000),
  }

  const result = await vm.runCall(runCallArgs)

  const expectedAddress = Buffer.from('8eae784e072e961f76948a785b62c9a950fb17ae', 'hex')
  const expectedCode = Buffer.from(
    '0000000000000000000000008eae784e072e961f76948a785b62c9a950fb17ae62c9a950fb17ae00000000000000000000000000000000000000000000000000',
    'hex'
  )

  t.ok(result.createdAddress?.buf.equals(expectedAddress), 'created address correct')
  const deployedCode = await vm.stateManager.getContractCode(result.createdAddress!)
  t.ok(deployedCode.equals(expectedCode), 'deployed code correct')

  t.end()
})
