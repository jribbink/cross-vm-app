import * as fcl from '@onflow/fcl'
import {parseAbi, encodeFunctionData} from 'viem'
import {useState} from 'react'

// Define the interface for each EVM call.
export interface EVMBatchCall {
  address: string;        // The target EVM contract address (as a string)
  abi: any;               // The contract ABI fragment (as JSON)
  functionName: string;   // The name of the function to call
  args: any[];            // The function arguments
}

// Helper to encode our calls using viem.
// Returns an array of objects with keys "address" and "data" (hex-encoded string without the "0x" prefix).
export function encodeCalls(calls: EVMBatchCall[]): Array<Array<{ key: string; value: string }>> {
  return calls.map(call => {
    const parsedAbi = parseAbi(call.abi)
    const encodedData = encodeFunctionData({
      abi: parsedAbi,
      functionName: call.functionName,
      args: call.args,
    })

    return [
      { key: "address", value: call.address },
      { key: "data", value: encodedData },
    ]
  })
}

// The Cadence transaction as a string.
// It expects a parameter of type [{String: String}] and loops through the calls to execute them atomically.
const cadenceTx = `
import EVM from 0x8c5303eaa26202d6

transaction(calls: [{String: String}]) {

    let coa: auth(EVM.Call) & EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) & Account) {
        let storagePath = /storage/evm
        self.coa = signer.storage.borrow<auth(EVM.Call) & EVM.CadenceOwnedAccount>(from: storagePath)
            ?? panic("No CadenceOwnedAccount (COA) found at ".concat(storagePath.toString()))
    }

    execute {
        for call in calls {
            let addrStr = call["address"]!
            let dataStr = call["data"]!
            let targetAddr = EVM.addressFromString(addrStr)
            let callData: [UInt8] = dataStr.decodeHex()
            let result = self.coa.call(
                to: targetAddr,
                data: callData,
                gasLimit: 15_000_000,
                value: EVM.Balance(attoflow: 0)
            )
            assert(
                result.status == EVM.Status.successful,
                message: "Call to ".concat(addrStr)
                          .concat(" failed: ")
                          .concat(result.errorMessage)
            )
        }
    }
}
`

// Custom hook that returns a function to send a batch transaction
export function useBatchTransaction() {
  const [txStatus, setTxStatus] = useState<string>('')

  async function sendBatchTransaction(calls: EVMBatchCall[]) {
    const encodedCalls = encodeCalls(calls)
    try {
      const txId = await fcl.mutate({
        cadence: cadenceTx,
        args: (arg, t) => [
          // Pass encodedCalls as an array of dictionaries with keys (String, String)
          arg(encodedCalls, t.Array(t.Dictionary({ key: t.String, value: t.String })))
        ],
        proposer: fcl.authz,
        payer: fcl.authz,
        authorizations: [fcl.authz],
        limit: 100,
      })
      setTxStatus(`Transaction submitted, ID: ${txId}`)
      console.log("Transaction submitted, ID:", txId)

      const txResult = await fcl.tx(txId).onceSealed()
      setTxStatus(`Transaction sealed: ${JSON.stringify(txResult)}`)
      console.log("Transaction sealed:", txResult)
    } catch (error: any) {
      setTxStatus(`Transaction error: ${error.message}`)
      console.error("Transaction error:", error)
    }
  }

  return {sendBatchTransaction, txStatus}
}