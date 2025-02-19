'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit';
import CodeEvaluator from './code-evaluator';
import { useAccount } from 'wagmi';
import { useEffect, useState } from 'react';
import * as fcl from '@onflow/fcl';
import { CurrentUser } from '@onflow/typedefs';
import {EVMBatchCall, useBatchTransaction} from "../hooks/useBatchTransaction";

function Page() {
  const coa = useAccount();
  const [flowAddress, setFlowAddress] = useState<string | null>(null);
  const {sendBatchTransaction, isPending, isError, txId, results} = useBatchTransaction();

  useEffect(() => {
    const unsub = fcl.currentUser().subscribe((user: CurrentUser) => {
      if (user.addr) {
        setFlowAddress(user.addr);
      }
    });
    return () => unsub();
  }, []);

  // Define a "real" calls array to demonstrate a batch transaction.
  // In this example, we call two functions on a token contract:
  // 1. deposit() to wrap FLOW (e.g., WFLOW)
  // 2. approve() to allow a spender to spend tokens.
  const calls: EVMBatchCall[] = [
    {
      // Call deposit() function (wrap FLOW) on the token contract.
      address: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // Replace with your actual token contract address.
      abi: [
        {
          inputs: [],
          name: "deposit",
          outputs: [],
          stateMutability: "payable",
          type: "function"
        }
      ],
      functionName: "deposit",
      args: [] // deposit takes no arguments; value is passed with the call.
    },
    {
      // Call approve() function (ERC20 style) on the same token contract.
      address: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // Replace with your actual token contract address if needed.
      abi: [
        {
          inputs: [
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" }
          ],
          name: "approve",
          outputs: [{ name: "", type: "bool" }],
          stateMutability: "nonpayable",
          type: "function"
        }
      ],
      functionName: "approve",
      args: [
        '0x2E2Ed0Cfd3AD2f1d34481277b3204d807Ca2F8c2', // Spender address.
        BigInt("1000000000000000000") // Approve 1 token (assuming 18 decimals).
      ]
    }
  ];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 12 }}>
        <ConnectButton />
      </div>
      <h3>Flow Address: {flowAddress}</h3>
      <h3>EVM Address: {coa?.address}</h3>
      <br />
      <button onClick={() => sendBatchTransaction(calls)}>
        Send Batch Transaction Example
      </button>
      {txStatus && <p>{txStatus}</p>}
      <CodeEvaluator />
    </>
  );
}

export default Page;
