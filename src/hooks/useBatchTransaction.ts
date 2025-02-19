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
  value?: number;          // The value to send with the call
}

export interface CallOutcome {
  status: 'passed' | 'failed' | 'skipped';
  hash?: string;
  errorMessage?: string;
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
      { key: "value",  value: call.value?.toString() ?? 0 },
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

transaction(calls: [{String: String}], mustPass: Bool) {

    let coa: auth(EVM.Call) & EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) & Account) {
        let storagePath = /storage/evm
        self.coa = signer.storage.borrow<auth(EVM.Call) & EVM.CadenceOwnedAccount>(from: storagePath)
            ?? panic("No CadenceOwnedAccount (COA) found at ".concat(storagePath.toString()))
    }

    execute {
        for i, call in calls {
            let addrStr = call["address"]!
            let dataStr = call["data"]!
            let valueStr = call["value"]!
            let targetAddr = EVM.addressFromString(addrStr)
            let callData: [UInt8] = dataStr.decodeHex()
            let valueAttoflow = UInt.fromString(valueStr) ?? panic("Could not construct UInt value from ".concat(valueStr))
            let result = self.coa.call(
                to: targetAddr,
                data: callData,
                gasLimit: 15_000_000,
                value: EVM.Balance(attoflow: valueAttoflow)
            )
            
            if mustPass {
                assert(
                  result.status == EVM.Status.successful,
                  message: "Call index ".concat(i.toString()).concat(" to ").concat(addrStr)
                    .concat(" with calldata ").concat(dataStr).concat(" failed: ")
                    .concat(result.errorMessage)
                )
            }
        }
    }
}
`
}

// Custom hook that returns a function to send a batch transaction
export function useBatchTransaction() {
  const { chain } = useAccount()

  const cadenceTx = chain?.id ? getCadenceBatchTransaction(chain.id) : null

  const [isPending, setIsPending] = useState<boolean>(false)
  const [isError, setIsError] = useState<boolean>(false)
  const [txId, setTxId] = useState<string>("")
  const [results, setResults] = useState<CallOutcome[]>([])

  async function sendBatchTransaction(calls: EVMBatchCall[]) {
    if (!cadenceTx) {
      throw new Error("No current chain found")
    }

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

      setTxId(txId)

      // The transaction may revert if mustPass=true and one of the calls fails,
      // so we catch that error specifically.
      let txResult
      try {
        txResult = await fcl.tx(txId).onceExecuted()
      } catch (txError) {
        // If we land here, the transaction likely reverted.
        // We can return partial or "failed" outcomes for all calls.
        setIsError(true)
        setResults(
          calls.map(() => ({
            status: "failed" as const,
            hash: undefined,
            errorMessage: "Transaction reverted"
          }))
        )
        setIsPending(false)
        return
      }

      // Filter for TransactionExecuted events
      const executedEvents = txResult.events.filter((e: any) =>
        e.type.includes("TransactionExecuted")
      )

      // Extract the transaction hashes from each event's data
      const txHashes = executedEvents.map((e: any) => e.data.txHash)

      // Build a full outcomes array for every call.
      // For any call index where no event exists, mark it as "skipped".
      const outcomes: CallOutcome[] = calls.map((_, index) => {
        const outcomeFromEvent = executedEvents.find((o: any) => o.index === index)
        if (outcomeFromEvent) {
          return {
            hash: outcomeFromEvent.txHash,
            status: outcomeFromEvent.statusCode === "0" ? "passed" : "failed",
            errorMessage: outcomeFromEvent.errorMessage
          }
        } else {
          return {
            hash: null,
            status: "skipped",
            errorMessage: null,
          }
        }
      })

      setResults(outcomes)
      setIsPending(false)
    } catch (error: any) {
      setIsError(true)
      setIsPending(false)
    }
  }

  return {sendBatchTransaction, isPending, isError, txId, results}
}