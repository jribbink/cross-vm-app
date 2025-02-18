import * as fcl from '@onflow/fcl'
import {parseAbi, encodeFunctionData} from 'viem'
import {useState} from 'react'
import {useAccount} from "wagmi";

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

const EVM_CONTRACT_ADDRESSES = {
  testnet: "0x8c5303eaa26202d6",
  mainnet: "0xe467b9dd11fa00df",
}

// Takes a chain id and returns the cadence tx with addresses set
const getCadenceBatchTransaction = (chainId: number) => {
  const isMainnet = chainId === 0x747
  const evmAddress = isMainnet ? EVM_CONTRACT_ADDRESSES.mainnet : EVM_CONTRACT_ADDRESSES.testnet

  return `
import EVM from ${evmAddress}

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
}

// Custom hook that returns a function to send a batch transaction
export function useBatchTransaction() {
  const { chain } = useAccount()

  if (!chain) {
    throw new Error("No chain provided.")
  }

  const cadenceTx = getCadenceBatchTransaction(chain.id)

  const [isPending, setIsPending] = useState<boolean>(false)
  const [isError, setIsError] = useState<boolean>(false)
  const [txHashes, setTxHashes] = useState<string[]>([])

  async function sendBatchTransaction(calls: EVMBatchCall[]) {
    const encodedCalls = encodeCalls(calls)
    try {
      setIsPending(true)
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

      const txResult = await fcl.tx(txId).onceExecuted()

      // Filter for TransactionExecuted events
      const executedEvents = txResult.events.filter((e: any) =>
        e.type.includes("TransactionExecuted")
      )

      // Extract the transaction hashes from each event's data
      const txHashes = executedEvents.map((e: any) => e.data.txHash)

      setTxHashes(txHashes)
      setIsPending(false)
    } catch (error: any) {
      setIsError(true)
      setIsPending(false)
    }
  }

  return {sendBatchTransaction, isPending, isError, txHashes}
}