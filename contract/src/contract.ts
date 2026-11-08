import {
  NearBindgen,
  near,
  call,
  view,
  initialize,
  UnorderedMap,
  Vector,
} from "near-sdk-js";

// ---------------------------------------------------------------------------
// VetoAgent — VetoGuard contract
//
// An on-chain policy guard for AI agents on NEAR.
//
// An agent's operating funds sit in a vault inside this contract. The agent
// can only move money by calling `request_payment`, and the contract checks
// every request against the policy its owner registered:
//
//   1. the agent must not be frozen (owner kill-switch),
//   2. the amount must be within the per-transaction cap,
//   3. the amount must fit inside the remaining daily cap,
//   4. the recipient must be on the owner's allowlist.
//
// If every check passes, the payment executes. If any check fails, the
// payment is VETOED, no funds move, and the attempt is written to a public
// audit log. An autonomous agent — honest, buggy, or prompt-injected —
// cannot spend outside the policy, because the policy is enforced by the
// contract, not by the agent's own code.
// ---------------------------------------------------------------------------

const YOCTO_PER_NEAR = 1_000_000_000_000_000_000_000_000n;

// Parse a decimal NEAR string like "0.5" or "2" into yoctoNEAR.
function parseNear(s: string): bigint {
  const parts = s.split(".");
  const whole = parts[0] === "" ? "0" : parts[0];
  const frac = ((parts[1] ?? "") + "000000000000000000000000").slice(0, 24);
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac);
}
const DAY_NS = 86_400_000_000_000n; // 24h in nanoseconds
const MAX_LOG_ENTRIES = 200;

interface Policy {
  per_tx_cap: string; // yoctoNEAR, decimal string
  daily_cap: string; // yoctoNEAR, decimal string
  allowlist: string[]; // NEAR account ids that may receive payments
  frozen: boolean;
}

interface AuditEntry {
  ts: string; // block timestamp, ns
  agent: string;
  recipient: string;
  amount: string; // yoctoNEAR
  status: "APPROVED" | "VETOED";
  reason: string;
}

@NearBindgen({ requireInit: true })
class VetoGuard {
  owner: string = "";
  policies: UnorderedMap<Policy> = new UnorderedMap<Policy>("p");
  vault: UnorderedMap<string> = new UnorderedMap<string>("v"); // agent -> yocto balance (decimal string)
  spentDay: UnorderedMap<string> = new UnorderedMap<string>("d"); // agent -> day index (decimal string)
  spentAmount: UnorderedMap<string> = new UnorderedMap<string>("s"); // agent -> yocto spent in current day
  log: Vector<string> = new Vector<string>("l"); // JSON-encoded AuditEntry

  @initialize({})
  init() {
    this.owner = near.predecessorAccountId();
    near.log(`VetoGuard initialized by ${this.owner}`);
  }

  // ------------------------------------------------------------- policy admin

  @call({})
  register_agent({
    agent,
    per_tx_cap_near,
    daily_cap_near,
    allowlist,
  }: {
    agent: string;
    per_tx_cap_near: string;
    daily_cap_near: string;
    allowlist: string[];
  }) {
    // Only the agent account itself (its key holder / owner) can set policy.
    if (near.predecessorAccountId() !== agent) {
      throw new Error("only the agent account can register its own policy");
    }
    const policy: Policy = {
      per_tx_cap: (parseNear(per_tx_cap_near)).toString(),
      daily_cap: (parseNear(daily_cap_near)).toString(),
      allowlist,
      frozen: false,
    };
    this.policies.set(agent, policy);
    if (this.vault.get(agent) === null) this.vault.set(agent, "0");
    near.log(
      `policy registered for ${agent}: per-tx cap ${per_tx_cap_near} NEAR, daily cap ${daily_cap_near} NEAR, allowlist ${allowlist.join(",")}`
    );
    return policy;
  }

  @call({})
  set_frozen({ agent, frozen }: { agent: string; frozen: boolean }) {
    if (near.predecessorAccountId() !== agent) {
      throw new Error("only the agent account can change its frozen state");
    }
    const policy = this.mustPolicy(agent);
    policy.frozen = frozen;
    this.policies.set(agent, policy);
    near.log(`agent ${agent} frozen=${frozen}`);
    return policy;
  }

  // ------------------------------------------------------------------- vault

  @call({ payableFunction: true })
  deposit({ agent }: { agent: string }) {
    // Anyone may fund an agent's vault; funds are credited to `agent`.
    this.mustPolicy(agent);
    const amount = near.attachedDeposit();
    const bal = BigInt(this.vault.get(agent) ?? "0") + amount;
    this.vault.set(agent, bal.toString());
    near.log(`deposit ${amount.toString()} yocto to vault of ${agent}`);
    return bal.toString();
  }

  @call({})
  withdraw({ agent, amount_near }: { agent: string; amount_near: string }) {
    // Only the agent account itself can pull its own vault funds back.
    if (near.predecessorAccountId() !== agent) {
      throw new Error("only the agent account can withdraw its vault funds");
    }
    const amount = parseNear(amount_near);
    const bal = BigInt(this.vault.get(agent) ?? "0");
    if (amount > bal) throw new Error("insufficient vault balance");
    this.vault.set(agent, (bal - amount).toString());
    const promise = near.promiseBatchCreate(agent);
    near.promiseBatchActionTransfer(promise, amount);
    near.promiseReturn(promise);
    near.log(`withdraw ${amount.toString()} yocto from vault of ${agent}`);
  }

  // ------------------------------------------------------------- the gate

  @call({})
  request_payment({
    recipient,
    amount_near,
    memo,
  }: {
    recipient: string;
    amount_near: string;
    memo: string;
  }): AuditEntry {
    const agent = near.predecessorAccountId();
    const amount = parseNear(amount_near);
    const policy = this.policies.get(agent);

    const entry: AuditEntry = {
      ts: near.blockTimestamp().toString(),
      agent,
      recipient,
      amount: amount.toString(),
      status: "APPROVED",
      reason: "within policy",
    };

    const veto = (reason: string): AuditEntry => {
      entry.status = "VETOED";
      entry.reason = reason;
      this.pushLog(entry);
      near.log(`VETOED ${agent} -> ${recipient} ${amount_near} NEAR: ${reason}`);
      return entry;
    };

    if (policy === null) return veto("agent has no registered policy");
    if (policy.frozen) return veto("agent is frozen by its owner");
    if (amount > BigInt(policy.per_tx_cap))
      return veto(
        `amount ${amount_near} NEAR exceeds per-transaction cap of ${(
          BigInt(policy.per_tx_cap) / YOCTO_PER_NEAR
        ).toString()} NEAR`
      );
    if (!policy.allowlist.includes(recipient))
      return veto(`recipient ${recipient} is not on the allowlist`);

    // daily cap accounting
    const today = (near.blockTimestamp() / DAY_NS).toString();
    let spent = 0n;
    if (this.spentDay.get(agent) === today) {
      spent = BigInt(this.spentAmount.get(agent) ?? "0");
    }
    if (spent + amount > BigInt(policy.daily_cap))
      return veto(
        `daily cap exceeded: already spent ${spent.toString()} yocto today, daily cap is ${policy.daily_cap} yocto`
      );

    const bal = BigInt(this.vault.get(agent) ?? "0");
    if (amount > bal) return veto("insufficient vault balance");

    // APPROVED — move the money.
    this.vault.set(agent, (bal - amount).toString());
    this.spentDay.set(agent, today);
    this.spentAmount.set(agent, (spent + amount).toString());
    this.pushLog(entry);
    const promise = near.promiseBatchCreate(recipient);
    near.promiseBatchActionTransfer(promise, amount);
    near.promiseReturn(promise);
    near.log(
      `APPROVED ${agent} -> ${recipient} ${amount_near} NEAR (${memo ?? ""})`
    );
    return entry;
  }

  // ------------------------------------------------------------------ views

  @view({})
  get_policy({ agent }: { agent: string }): Policy | null {
    return this.policies.get(agent);
  }

  @view({})
  get_vault_balance({ agent }: { agent: string }): string {
    return this.vault.get(agent) ?? "0";
  }

  @view({})
  get_spent_today({ agent }: { agent: string }): string {
    const today = (near.blockTimestamp() / DAY_NS).toString();
    if (this.spentDay.get(agent) !== today) return "0";
    return this.spentAmount.get(agent) ?? "0";
  }

  @view({})
  get_audit_log({ limit }: { limit: number }): AuditEntry[] {
    const n = this.log.length;
    const take = Math.min(limit ?? 20, n);
    const out: AuditEntry[] = [];
    for (let i = n - take; i < n; i++) {
      out.push(JSON.parse(this.log.get(i) as string) as AuditEntry);
    }
    return out.reverse();
  }

  // ---------------------------------------------------------------- helpers

  mustPolicy(agent: string): Policy {
    const p = this.policies.get(agent);
    if (p === null) throw new Error(`no policy registered for ${agent}`);
    return p as Policy;
  }

  pushLog(entry: AuditEntry) {
    this.log.push(JSON.stringify(entry));
    if (this.log.length > MAX_LOG_ENTRIES) {
      // keep the log bounded: drop the oldest half
      const kept: string[] = [];
      for (let i = MAX_LOG_ENTRIES / 2; i < this.log.length; i++) {
        kept.push(this.log.get(i) as string);
      }
      this.log.clear();
      for (const k of kept) this.log.push(k);
    }
  }
}
