import * as fcl from '@onflow/fcl'
import {Abi, encodeFunctionData} from 'viem'
import {useState} from 'react'
import {useAccount} from "wagmi";

// Define the interface for each EVM call.
export interface EVMBatchCall {
  address: string;            // The target EVM contract address (as a string)
  abi: Abi;                   // The contract ABI fragment (as JSON)
  functionName: string;       // The name of the function to call
  args?: readonly unknown[];  // The function arguments
  gasLimit?: bigint;           // The gas limit for the call
  value?: bigint;             // The value to send with the call
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
    const encodedData = encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    })

    return [
      { key: "to", value: call.address },
      { key: "data", value: fcl.sansPrefix(encodedData) ?? "" },
      { key: "gasLimit", value: call.gasLimit?.toString() ?? "15000000" },
      { key: "value",  value: call.value?.toString() ?? "0" },
    ]
  }) as any
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

transaction(calls: [{String: AnyStruct}], mustPass: Bool) {

    let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) & Account) {
        let storagePath = /storage/evm
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: storagePath)
            ?? panic("No CadenceOwnedAccount (COA) found at ".concat(storagePath.toString()))
    }

    execute {
        for i, call in calls {
            let to = call["to"] as! String
            let data = call["data"] as! String
            let gasLimit = call["gasLimit"] as! UInt64
            let value = call["value"] as! UInt

            let result = self.coa.call(
                to: EVM.addressFromString(to),
                data: data.decodeHex(),
                gasLimit: gasLimit,
                value: EVM.Balance(attoflow: value)
            )
            
            if mustPass {
                assert(
                  result.status == EVM.Status.successful,
                  message: "Call index ".concat(i.toString()).concat(" to ").concat(to)
                    .concat(" with calldata ").concat(data).concat(" failed: ")
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

  async function sendBatchTransaction(calls: EVMBatchCall[], mustPass: boolean = true) {
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
          arg(encodedCalls, t.Array(t.Dictionary([
            { key: t.String, value: t.String },
            { key: t.String, value: t.String },
            { key: t.String, value: t.UInt64 },
            { key: t.String, value: t.UInt },
          ] as any))),
          // Pass mustPass=true to revert the entire transaction if any call fails
          arg(true, t.Bool),
        ],
        limit: 9999,
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

      // Build a full outcomes array for every call.
      // For any call index where no event exists, mark it as "skipped".
      const outcomes: CallOutcome[] = calls.map((_, index) => {
        const outcomeFromEvent = executedEvents.find((o: any) => o.index === index)?.data
        if (outcomeFromEvent) {
          return {
            hash: outcomeFromEvent.txHash,
            status: outcomeFromEvent.statusCode === "0" ? "passed" : "failed",
            errorMessage: outcomeFromEvent.errorMessage
          }
        } else {
          return {
            status: "skipped",
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