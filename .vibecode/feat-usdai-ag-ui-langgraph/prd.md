# Product Requirements Document: AG-UI LangGraph USDAi Strategy Agent

Created: 2025-12-05T22:33:42-05:00  
Status: Approved  
Branch: feat/usdai-ag-ui-langgraph

## Overview

Convert the existing imperative USDai workflow (`usdai-strategy.ts`) into an AG-UI compatible LangGraph agent (`agent.ts`) located in `integrations/langgraph/typescript/examples/src/agents/usdai`. The new agent must reproduce the current strategy’s behavior (status updates, artifacts, user interrupts, delegation signing, approvals, liquidity execution, debug mode) without introducing LLM dependencies.

## Business Requirements

### Objectives

- Enable AG-UI to run the USDai Pendle strategy via LangGraph, preserving the current user experience (artifacts, progress, dashboard-style data).
- Keep execution non-LLM and deterministic, leveraging existing viem/metamask logic.
- Maintain user control and transparency around delegations and transactions through artifacts and interrupts.

### User Stories

- As a user, I want to review required delegations and sign them before the agent transacts, so I keep control of my wallet.
- As a user, I want to see status updates and streamed transaction history while the strategy runs, so I understand progress and outcomes.
- As a developer, I want the strategy exposed as a compiled LangGraph graph the AG-UI runtime can load, so it fits the integration demos.

## Success Criteria

- [ ] `integrations/langgraph/typescript/examples/src/agents/usdai/agent.ts` exports a compiled LangGraph graph that AG-UI can register and execute.
- [ ] The agent reproduces all user-facing outputs from `usdai-strategy.ts`: initial strategy cards, delegation artifacts (preview + data), dashboard artifacts (settings, policies, transaction history), and status updates.
- [ ] User interrupts remain in place for (a) wallet+amount input and (b) returning signed delegations; execution resumes correctly with provided data.
- [ ] DEBUG_MODE path skips on-chain calls but still emits deterministic artifacts and receipts; non-debug path invokes existing utility functions for approvals and liquidity supply.
- [ ] ENV requirement `A2A_TEST_AGENT_NODE_PRIVATE_KEY` is validated early with a clear error if missing.
- [ ] Streaming/append behavior for transaction history artifacts is preserved so AG-UI renders incremental updates.
- [ ] STATE_SNAPSHOT / STATE_DELTA emission is supported via LangGraph state updates (or manual emits if necessary) so AG-UI can reflect state changes; interrupts are surfaced through LangGraph `interrupt` to mirror the prior generator `interrupted` yields.

## Technical Requirements

### Functional Requirements

- Implement the USDai strategy as a LangGraph workflow using the existing logic from `usdai-strategy.ts`; no LLM/model calls.
- Maintain all existing artifacts’ structures (IDs, names, descriptions, and data shapes) and status/update semantics.
- Preserve interrupt points and required input schemas (wallet+amount, signed delegations).
- Map existing generator yields (`status-update`, `artifact`, `interrupted`) to LangGraph state/commands so AG-UI receives equivalent events.
- Keep STREAM_LIMIT/STREAM_DELAY behavior for iterative supply steps; ensure delay is respected without blocking AG-UI updates.
- Emit status updates in a way AG-UI can display (plan: carry a `status` field in state plus a custom event so snapshots/deltas include it; confirm with AG-UI expectations).

### Non-Functional Requirements

- TypeScript ES2022, NodeNext, strict mode; no `any`.
- No new external dependencies beyond current workspace; use pnpm if additions become necessary.
- Must pass `pnpm lint` and `pnpm build`.
- Follow project conventions: no backward-compat layers, no deprecated aliases, no dotenv usage (environment loaded via node `--env-file` scripts).

## Integration Points

- Uses existing utilities in `integrations/langgraph/typescript/examples/src/agents/usdai/workflows/utils/*` (`clients`, `allowance`, `trading`, etc.).
- Depends on viem, MetaMask delegation toolkit, uuid, and zod already in the workspace.
- Environment variables: `A2A_TEST_AGENT_NODE_PRIVATE_KEY` (required), `DEBUG_MODE` (optional).
- AG-UI LangGraph bridge for messages, artifacts, interrupts, and state streaming (align with patterns from other example agents).

## Constraints & Considerations

### Technical Constraints

- No LLM/tooling should be introduced; execution must stay deterministic.
- On-chain calls must respect existing debug bypass; production paths assume RPC connectivity provided by `createClients`.
- Message/asset payload shapes must remain stable to avoid frontend rendering regressions.

### Business Constraints

- Time-to-demo priority: keep scope limited to parity conversion, not feature expansion.

### Risks

- Missing env var halts startup; need explicit early failure.
- Divergence in artifact IDs or shapes could break existing AG-UI views.
- Streaming/append semantics may differ if LangGraph state updates are mishandled.

## Architectural Decisions

### Decision 1: Workflow representation via LangGraph (needs approval)

- **What**: Represent the USDai strategy as a LangGraph `StateGraph`-compiled agent with command-based control flow instead of generator-based `WorkflowPlugin`.
 - **Why**: AG-UI integration layer expects LangGraph agents; aligns with other examples and enables uniform runtime handling.
 - **Alternatives**: Keep generator plugin and wrap; rejected to avoid dual paradigms and extra adapter code.
 - **Trade-offs**: Slight refactor cost; gains alignment and consistency.  
 - **Requires documentation in rationales.md**: Yes (once approved).

### Decision 2: Preserve artifact/interrupt schema verbatim (needs approval)

- **What**: Keep the artifact IDs, descriptions, and input schemas identical to `usdai-strategy.ts` while translating to LangGraph events.
- **Why**: Ensures frontend components render unchanged; minimizes regression risk.
- **Alternatives**: Redesign payloads for LangGraph-native structures; rejected due to higher QA surface.
- **Trade-offs**: Less cleanup/normalization now; maintains compatibility.  
- **Requires documentation in rationales.md**: Yes (once approved).

## Out of Scope

- Re-enabling payment settlement flow (currently commented).
- Introducing LLM-powered decision-making.
- Expanding strategy logic beyond current approvals/liquidity supply and streaming iterations.

## Open Questions
None. (Status in state only; rely on built-in LangGraph snapshots/deltas; export graph as `usdaiAgentGraph`.)

## Optional Sections

### Backwards Compatibility

- Existing non-LangGraph workflow is replaced; no compatibility layer will be maintained.

### Reference Patterns

- Mirror patterns from `shared_state`, `agentic_generative_ui`, and `predictive_state_updates` examples for state streaming, appendable artifacts, and interrupts.
