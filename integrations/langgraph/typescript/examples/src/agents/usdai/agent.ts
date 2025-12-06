/**
 * LangGraph implementation of the USDai Pendle strategy (no LLM).
 * Mirrors the behavior of workflows/usdai-strategy.ts using AG-UI compatible state,
 * artifacts, and interrupts.
 */

import { createDelegation, Implementation, toMetaMaskSmartAccount } from "@metamask/delegation-toolkit";
import { Annotation, Command, MessagesAnnotation, StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { formatUnits, keccak256, parseUnits, toBytes } from "viem";
import type { Client, PublicActions, PublicRpcSchema, Transport } from "viem";
import type { Chain } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import type { Artifact } from "@a2a-js/sdk";

import { approveTokenDirectStep } from "./workflows/utils/allowance.js";
import { createClients } from "./workflows/utils/clients.js";
import { executeSupplyUsdaiLiquidity } from "./workflows/utils/trading.js";

// Constants (kept identical to original workflow)
const USDAI_TOKEN = {
  address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
  decimals: 18,
} as const;

const PENDLE_SWAP = {
  address: "0x888888888889758F76e7103c6CbF23ABbF58F946",
  selector: "0x12599ac6",
  usdAiPool: "0x8e101c690390de722163d4dc3f76043bebbbcadd",
} as const;

// Hard-coded to match original workflow behavior
const STREAM_LIMIT = 1;
const STREAM_DELAY_MS = 3000;

// Environment
const agentPrivateKey = process.env["A2A_TEST_AGENT_NODE_PRIVATE_KEY"];
if (!agentPrivateKey) {
  throw new Error("A2A_TEST_AGENT_NODE_PRIVATE_KEY environment variable is required");
}

const DEBUG_MODE = process.env["DEBUG_MODE"] === "true";

type WalletAndAmount = {
  walletAddress: `0x${string}`;
  amount: string;
};

type DelegationMap = {
  approveUsdai: ReturnType<typeof createDelegation>;
  supplyPendle: ReturnType<typeof createDelegation>;
};

type SignedDelegations = {
  approveUsdai: string;
  supplyPendle: string;
};

const walletAndAmountSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid EVM address") as z.ZodType<`0x${string}`>,
  amount: z.string(),
});

const signedDelegationsSchema = z.object({
  delegations: z.array(
    z.object({
      id: z.enum(["approveUsdai", "supplyPendle"]),
      signedDelegation: z.string().regex(/^0x[0-9a-fA-F]+$/, "Must be a hex signature") as z.ZodType<`0x${string}`>,
    })
  ),
});

const AgentStateAnnotation = Annotation.Root({
  status: Annotation<string | undefined>({
    reducer: (_left, right) => right ?? _left,
    default: () => undefined,
  }),
  artifacts: Annotation<Artifact[]>({
    reducer: (_left, right) => right ?? _left,
    default: () => [],
  }),
  userWalletInput: Annotation<WalletAndAmount | undefined>({
    reducer: (_left, right) => right ?? _left,
    default: () => undefined,
  }),
  delegations: Annotation<DelegationMap | undefined>({
    reducer: (_left, right) => right ?? _left,
    default: () => undefined,
  }),
  signedDelegations: Annotation<SignedDelegations | undefined>({
    reducer: (_left, right) => right ?? _left,
    default: () => undefined,
  }),
  iteration: Annotation<number>({
    reducer: (_left, right) => (right ?? _left),
    default: () => 0,
  }),
  tools: Annotation<unknown[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  ...MessagesAnnotation.spec,
});

type AgentState = typeof AgentStateAnnotation.State;

/**
 * Merge or append artifacts while preserving append semantics.
 */
function mergeArtifactList(existing: Artifact[] | undefined, incoming: Artifact, append = false): Artifact[] {
  const artifacts = [...(existing ?? [])];
  const idx = artifacts.findIndex((a) => a.artifactId === incoming.artifactId);

  if (append && idx >= 0) {
    const previous = artifacts[idx];
    artifacts[idx] = {
      ...previous,
      parts: [...(previous.parts ?? []), ...(incoming.parts ?? [])],
    };
    return artifacts;
  }

  if (idx >= 0) {
    artifacts[idx] = incoming;
  } else {
    artifacts.push(incoming);
  }
  return artifacts;
}

function buildStrategyCardArtifact(): Artifact {
  return {
    artifactId: "strategy-input-display",
    name: "strategy-input-display.json",
    description: "Strategy input",
    parts: [
      {
        kind: "data",
        data: {
          name: "USDai Pendle Allo",
          subtitle: "by @0xfarmer",
          token: "USDAi",
          chains: [
            {
              chainName: "Arbitrum",
              chainIconUri: "https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242",
            },
            {
              chainName: "Plasma",
              chainIconUri: "https://assets.coingecko.com/coins/images/66489/standard/Plasma-symbol-green-1.png?1755142558",
            },
          ],
          protocol: "Pendle",
          tokenIconUri:
            "https://assets.coingecko.com/coins/images/55857/standard/USDai_Token_Full_Glyph.png?1755229050",
          platformIconUri:
            "https://assets.coingecko.com/coins/images/15069/standard/Pendle_Logo_Normal-03.png?1696514728",
          rewards: [
            { type: "points", multiplier: 25, reward: "Allo points" },
            { type: "apy", percentage: 15, reward: "APY" },
          ],
        },
      },
    ],
  };
}

function buildDelegationsDisplayArtifact(): Artifact {
  return {
    artifactId: "delegations-display",
    name: "delegations-display.json",
    description: "Delegations that need to be signed to the user",
    parts: [
      {
        kind: "data",
        data: {
          delegationId: "approveUsdai",
          name: "Policy 1: USDai Approval",
          description:
            "This policy enables the agent to approve the user's USDai to be submitted to Pendle. You retain full control over your wallet and can revoke access at any time.",
          policy: "USDai Approval: Unlimited",
        },
      },
      {
        kind: "data",
        data: {
          delegationId: "supplyPendle",
          name: "Policy 2: Pendle Liquidity Supply",
          description:
            "This policy enables the agent to supply the user's USDai to Pendle. You retain full control over your wallet and can revoke access at any time.",
          policy: "Pendle Liquidity Supply: Unlimited",
        },
      },
    ],
  };
}

function buildDelegationsDataArtifact(delegations: DelegationMap): Artifact {
  return {
    artifactId: "delegations-data",
    name: "delegations-data.json",
    description: "Delegations that need to be signed to the user",
    parts: [
      {
        kind: "data",
        data: {
          id: "approveUsdai",
          description: "Allow agent to approve user's USDai to be submitted to Pendle.",
          delegation: delegations.approveUsdai,
        },
      },
      {
        kind: "data",
        data: {
          id: "supplyPendle",
          description: "Allow agent to supply user's USDai to Pendle.",
          delegation: delegations.supplyPendle,
        },
      },
    ],
  };
}

function buildDashboardArtifact(): Artifact {
  return {
    artifactId: "strategy-dashboard-display",
    name: "strategy-dashboard-display.json",
    description: "This strategy optimizes USDai Allopoints via Pendle LPs/PTs across Arbitrum and Plasma",
    parts: [
      {
        kind: "data",
        data: {
          name: "USDai Pendle Allo",
          curator: "Curated by @0xfarmer",
          infoChip: "USDai Allo Points",
          token: "USDAi",
          chains: [
            {
              chainName: "Arbitrum",
              chainIconUri: "https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242",
            },
            {
              chainName: "Plasma",
              chainIconUri: "https://assets.coingecko.com/coins/images/66489/standard/Plasma-symbol-green-1.png?1755142558",
            },
          ],
          protocol: "Pendle",
          tokenIconUri:
            "https://assets.coingecko.com/coins/images/55857/standard/USDai_Token_Full_Glyph.png?1755229050",
          platformIconUri:
            "https://assets.coingecko.com/coins/images/15069/standard/Pendle_Logo_Normal-03.png?1696514728",
          rewards: [
            { type: "points", multiplier: 25, reward: "Allo points" },
            { type: "apy", percentage: 15, reward: "APY" },
          ],
          performance: {
            cumlativePoints: "12333",
            totalValueUsd: "510",
          },
        },
      },
    ],
  };
}

function buildEmptyHistoryArtifact(): Artifact {
  return {
    artifactId: "transaction-history-display",
    name: "transaction-history-display.json",
    description: "Transaction history for the strategy (streamed)",
    parts: [],
  };
}

function buildSettingsArtifact(amount: string): Artifact {
  const amountUnits = parseUnits(amount, USDAI_TOKEN.decimals);
  return {
    artifactId: "strategy-settings-display",
    name: "strategy-settings-display.json",
    description: "Strategy settings",
    parts: [
      {
        kind: "data",
        data: {
          name: "USDai Pendle Allo",
          description: "Total funds allocated to this strategy . Can be modified to increase exposure",
          amount: formatUnits(amountUnits / 2n, USDAI_TOKEN.decimals),
        },
      },
      {
        kind: "data",
        data: {
          name: "Max Daily Movements",
          description:
            "The total volume of assets the A I agent is permitted to transfer, swap, or reallocate within a 24-hour period.",
          amount: formatUnits(amountUnits / 10n, USDAI_TOKEN.decimals),
        },
      },
      {
        kind: "data",
        data: {
          name: "Preferred Asset",
          description:
            "The agent will first use the preferred asset to implement the strategy, and if it's unavailable, it will swap from whitelisted assets to fulfill the need.",
          asset: "USDAi",
        },
      },
    ],
  };
}

function buildPoliciesArtifact(amount: string): Artifact {
  return {
    artifactId: "strategy-policies-display",
    name: "strategy-policies-display.json",
    description: "Policies for the strategy",
    parts: [
      {
        kind: "data",
        data: {
          delegationId: "approveUsdai",
          name: "Policy 1: USDai Approval",
          assets: ["USDAi"],
          amount,
        },
      },
      {
        kind: "data",
        data: {
          delegationId: "supplyPendle",
          name: "Policy 2: Pendle Liquidity Supply",
          assets: ["USDAi"],
          amount,
        },
      },
    ],
  };
}

function buildApprovalHistoryEntry(amount: string, receiptHash: string): Artifact {
  return {
    artifactId: "transaction-history-display",
    name: "transaction-history-display.json",
    description: "Transaction history for the strategy (streamed)",
    parts: [
      {
        kind: "data",
        data: {
          type: "Approval",
          timestamp: new Date().toISOString(),
          token: "USDAi",
          amount,
          receiptHash,
          delegationsUsed: ["approveUsdai"],
        },
      },
    ],
  };
}

function buildSupplyHistoryEntry(amountWei: bigint, receiptHash: string): Artifact {
  return {
    artifactId: "transaction-history-display",
    name: "transaction-history-display.json",
    description: "Transaction history for the strategy (streamed)",
    parts: [
      {
        kind: "data",
        data: {
          type: "Supply Liquidity",
          timestamp: new Date().toISOString(),
          token: "USDAi",
          amount: formatUnits(amountWei, USDAI_TOKEN.decimals),
          protocol: "Pendle",
          receiptHash,
          delegationsUsed: ["supplyPendle"],
        },
      },
    ],
  };
}

async function createAgentWallet() {
  const clients = createClients();
  const account = privateKeyToAccount(agentPrivateKey as `0x${string}`);
  const agentsWallet = await toMetaMaskSmartAccount({
    client: clients.public as Client<Transport, Chain | undefined, undefined, PublicRpcSchema, PublicActions<Transport, Chain | undefined>>,
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: "0x",
    signer: { account },
  });
  return { agentsWallet, clients };
}

async function startNode(state: AgentState): Promise<Command> {
  const artifacts = mergeArtifactList(state.artifacts, buildStrategyCardArtifact());

  return new Command({
    goto: "request_user_input",
    update: {
      artifacts,
      status: "Starting USDAi Points Trading Strategy workflow...",
    },
  });
}

async function requestUserInputNode(state: AgentState): Promise<Command> {
  let userWalletInput = state.userWalletInput;

  if (!userWalletInput) {
    const interruptPayload = {
      reason: "input-required",
      message: "Please confirm the wallet and amount of USDai to be used for the strategy",
      inputSchema: {
        type: "object",
        properties: {
          walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          amount: { type: "string" },
        },
        required: ["walletAddress", "amount"],
      },
    };

    const userInput = interrupt(interruptPayload);
    userWalletInput = walletAndAmountSchema.parse(userInput);
  }

  return new Command({
    goto: "create_delegations",
    update: {
      userWalletInput,
      status: `Creating delegations for ${userWalletInput.walletAddress} to supply ${userWalletInput.amount} USDai...`,
    },
  });
}

async function createDelegationsNode(state: AgentState): Promise<Command> {
  if (!state.userWalletInput) {
    throw new Error("userWalletInput missing when creating delegations");
  }

  const { agentsWallet, clients } = await createAgentWallet();
  const delegations: DelegationMap = {
    approveUsdai: createDelegation({
      scope: {
        type: "functionCall",
        targets: [USDAI_TOKEN.address],
        selectors: ["approve(address, uint256)"],
      },
      to: agentsWallet.address,
      from: state.userWalletInput.walletAddress,
      environment: agentsWallet.environment,
    }),
    supplyPendle: createDelegation({
      scope: {
        type: "functionCall",
        targets: [PENDLE_SWAP.address],
        selectors: [PENDLE_SWAP.selector],
      },
      to: agentsWallet.address,
      from: state.userWalletInput.walletAddress,
      environment: agentsWallet.environment,
    }),
  };

  // createDelegation is pure; clients not needed beyond wallet creation here
  void clients;

  let artifacts = mergeArtifactList(state.artifacts, buildDelegationsDisplayArtifact());
  artifacts = mergeArtifactList(artifacts, buildDelegationsDataArtifact(delegations));

  return new Command({
    goto: "wait_signed_delegations",
    update: {
      delegations,
      artifacts,
    },
  });
}

async function waitSignedDelegationsNode(state: AgentState): Promise<Command> {
  if (!state.userWalletInput || !state.delegations) {
    throw new Error("Missing user input or delegations when waiting for signed delegations");
  }

  let signedDelegations = state.signedDelegations;

  if (!signedDelegations) {
    const interruptPayload = {
      reason: "input-required",
      message: "Please sign all delegations and submit them",
      artifactId: "delegations-data",
      inputSchema: {
        type: "object",
        properties: {
          delegations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", enum: ["approveUsdai", "supplyPendle"] },
                signedDelegation: { type: "string" },
              },
              required: ["id", "signedDelegation"],
            },
          },
        },
        required: ["delegations"],
      },
    };

    const userResponse = interrupt(interruptPayload);
    const parsed = signedDelegationsSchema.parse(userResponse);

    signedDelegations = {
      approveUsdai: parsed.delegations.find((d) => d.id === "approveUsdai")!.signedDelegation,
      supplyPendle: parsed.delegations.find((d) => d.id === "supplyPendle")!.signedDelegation,
    };
  }

  return new Command({
    goto: "approve",
    update: {
      signedDelegations,
      artifacts: mergeArtifactList(state.artifacts, buildDashboardArtifact()),
      status: "Signed delegations received. Simulating some work with progress updates...",
    },
  });
}

async function approveNode(state: AgentState): Promise<Command> {
  if (!state.userWalletInput || !state.delegations || !state.signedDelegations) {
    throw new Error("Missing required state for approval");
  }

  const exactAmount = parseUnits(state.userWalletInput.amount, USDAI_TOKEN.decimals);
  const { agentsWallet, clients } = await createAgentWallet();

  let approveReceiptHash: string | undefined;
  if (DEBUG_MODE) {
    approveReceiptHash = keccak256(toBytes("debug-approval-tx"));
  } else {
    const fullReceipt = await approveTokenDirectStep(
      USDAI_TOKEN.address,
      exactAmount,
      {
        ...state.delegations.approveUsdai,
        signature: state.signedDelegations.approveUsdai,
      },
      agentsWallet,
      state.userWalletInput.walletAddress,
      PENDLE_SWAP.address,
      clients,
    );
    approveReceiptHash = fullReceipt?.transactionHash;
  }

  let artifacts = state.artifacts;
  if (approveReceiptHash) {
    artifacts = mergeArtifactList(
      mergeArtifactList(artifacts, buildEmptyHistoryArtifact()),
      buildApprovalHistoryEntry(state.userWalletInput.amount, approveReceiptHash),
      true,
    );
  }

  return new Command({
    goto: "supply_loop",
    update: {
      artifacts,
      iteration: 0,
      status: `Supplying liquidity for ${state.userWalletInput.amount} USDai...`,
    },
  });
}

async function supplyLoopNode(state: AgentState): Promise<Command> {
  if (!state.userWalletInput || !state.delegations || !state.signedDelegations) {
    throw new Error("Missing required state for supply loop");
  }

  const currentIteration = state.iteration ?? 0;
  if (currentIteration >= STREAM_LIMIT) {
    return new Command({
      goto: END,
      update: {
        status: "Strategy execution completed.",
      },
    });
  }

  const amountWei = parseUnits(state.userWalletInput.amount, USDAI_TOKEN.decimals);
  const { agentsWallet, clients } = await createAgentWallet();

  let receiptHash: string;
  if (DEBUG_MODE) {
    receiptHash = keccak256(toBytes(`debug-supply-tx-${currentIteration}`));
  } else {
    const fullReceipt = await executeSupplyUsdaiLiquidity(
      {
        ...state.delegations.supplyPendle,
        signature: state.signedDelegations.supplyPendle,
      },
      agentsWallet,
      state.userWalletInput.walletAddress,
      clients,
      PENDLE_SWAP.address,
      PENDLE_SWAP.usdAiPool,
      USDAI_TOKEN.address,
      amountWei,
    );
    receiptHash = fullReceipt.transactionHash;
  }

  // Append transaction history
  let artifacts = mergeArtifactList(
    mergeArtifactList(state.artifacts, buildEmptyHistoryArtifact()),
    buildSupplyHistoryEntry(amountWei, receiptHash),
    true,
  );

  // Ensure settings and policies are present (only once)
  if (!artifacts.some((a) => a.artifactId === "strategy-settings-display")) {
    artifacts = mergeArtifactList(artifacts, buildSettingsArtifact(state.userWalletInput.amount));
  }
  if (!artifacts.some((a) => a.artifactId === "strategy-policies-display")) {
    artifacts = mergeArtifactList(artifacts, buildPoliciesArtifact(state.userWalletInput.amount));
  }

  // Respect streaming delay
  await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));

  return new Command({
    goto: "supply_loop",
    update: {
      artifacts,
      iteration: currentIteration + 1,
      status: `Streaming transaction ${currentIteration + 1}/${STREAM_LIMIT}`,
    },
  });
}

const workflow = new StateGraph<AgentState>(AgentStateAnnotation);
workflow.addNode("start", startNode);
workflow.addNode("request_user_input", requestUserInputNode);
workflow.addNode("create_delegations", createDelegationsNode);
workflow.addNode("wait_signed_delegations", waitSignedDelegationsNode);
workflow.addNode("approve", approveNode);
workflow.addNode("supply_loop", supplyLoopNode);

workflow.addEdge(START, "start");
workflow.addEdge("start", "request_user_input");
workflow.addEdge("request_user_input", "create_delegations");
workflow.addEdge("create_delegations", "wait_signed_delegations");
workflow.addEdge("wait_signed_delegations", "approve");
workflow.addEdge("approve", "supply_loop");
workflow.addEdge("supply_loop", "supply_loop");
workflow.addEdge("supply_loop", END);

export const usdaiAgentGraph = workflow.compile();
